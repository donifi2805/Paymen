const admin = require('firebase-admin');

// Inisialisasi Firebase
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// UPDATE: Regex sekarang menerima huruf A-Z di RefID
const RX = /RC=(?<reffid>[a-zA-Z0-9-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)\s*(?<keterangan>.+?)(?:\s+Saldo[\s\S]*?)?(?:\bresult=(?<status_code>\d+))?\s*>?$/i;

export default async function handler(req, res) {
    try {
        const message = 
            (req.query && req.query.message) || 
            (req.body && req.body.message) || 
            null;

        if (!message) {
            return res.status(400).json({ ok: false, error: 'message kosong' });
        }

        console.log('[WEBHOOK RAW]:', message);

        const match = message.match(RX);
        
        if (!match || !match.groups) {
            console.log('[WEBHOOK] Format tidak dikenali:', message);
            return res.status(200).json({ ok: false, error: 'format tidak dikenali' });
        }

        const {
            reffid,
            status_text,
            status_code: statusCodeRaw,
        } = match.groups;

        const keterangan = (match.groups.keterangan || '').trim();

        let status_code = null;
        if (statusCodeRaw != null) {
            status_code = Number(statusCodeRaw);
        } else {
            if (/sukses/i.test(status_text)) status_code = 0;
            else if (/gagal|batal/i.test(status_text)) status_code = 1;
        }

        // Cari Transaksi
        const historyQuery = await db.collectionGroup("history")
            .where("trx_id", "==", reffid) 
            .limit(1)
            .get();

        if (historyQuery.empty) {
            return res.status(200).json({ ok: false, error: 'Trx Not Found' });
        }

        const docSnapshot = historyQuery.docs[0];
        const docRef = docSnapshot.ref;
        const currentData = docSnapshot.data();
        
        if (['Sukses', 'Gagal'].includes(currentData.status)) {
            return res.status(200).json({ ok: true, msg: "Already Finalized" });
        }

        // Update Database & Refund
        await db.runTransaction(async (t) => {
            const userRef = docRef.parent.parent;
            const userDoc = await t.get(userRef);
            
            let newStatus = 'Pending';
            let shouldRefund = false;

            if (status_code === 0) {
                newStatus = 'Sukses';
            } else if (status_code === 1) {
                newStatus = 'Gagal';
                shouldRefund = true;
            }

            let updatePayload = {
                status: newStatus,
                sn: keterangan,
                api_msg: `Webhook: ${status_text}`,
                last_updated: admin.firestore.FieldValue.serverTimestamp(),
                raw_webhook_message: message
            };

            if (shouldRefund) {
                const currentBalance = parseInt(userDoc.data().balance) || 0;
                const refundAmount = parseInt(currentData.amount) || 0;
                t.update(userRef, { balance: currentBalance + refundAmount });
                updatePayload.api_msg = `REFUND: ${keterangan}`;
            }

            t.update(docRef, updatePayload);
        });

        return res.status(200).json({ ok: true, parsed: match.groups });

    } catch (error) {
        console.error('[ERROR]', error);
        return res.status(500).json({ ok: false, error: error.message });
    }
}