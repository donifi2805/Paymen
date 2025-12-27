const admin = require('firebase-admin');

// Inisialisasi Firebase (Hanya sekali)
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

/**
 * REGEX FINAL (Sempurna):
 * Mendukung format TRX-ID yang mengandung angka, huruf, tanda hubung, titik, dan underscore.
 */
const RX = /RC=(?<reffid>[a-zA-Z0-9._-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)\s*(?<keterangan>.+?)(?:\s+Saldo[\s\S]*?)?(?:\bresult=(?<status_code>\d+))?\s*>?$/i;

export default async function handler(req, res) {
    // 1. Tangkap Pesan (Mendukung GET query atau POST body)
    const message = 
        (req.query && req.query.message) || 
        (req.body && req.body.message) || 
        null;

    if (!message) {
        return res.status(400).json({ ok: false, error: 'Message kosong' });
    }

    console.log('[WEBHOOK RAW]:', message);

    try {
        // 2. Parsing Pesan
        const match = message.match(RX);
        
        if (!match || !match.groups) {
            console.log('[WEBHOOK] Format tidak dikenali:', message);
            return res.status(200).json({ ok: false, error: 'Format tidak dikenali' });
        }

        const {
            reffid,         // ID Transaksi kita (Contoh: TRX-173529...)
            status_text,    // Sukses / Gagal / Batal
            status_code: statusCodeRaw,
        } = match.groups;

        const keterangan = (match.groups.keterangan || '').trim();

        // 3. Normalisasi Status Code
        let status_code = null;
        if (statusCodeRaw != null) {
            status_code = Number(statusCodeRaw);
        } else {
            // Fallback manual berdasarkan teks jika result= tidak dikirim
            if (/sukses/i.test(status_text)) status_code = 0;
            else if (/gagal|batal/i.test(status_text)) status_code = 1;
        }

        // 4. Cari Transaksi di Database menggunakan Collection Group (history kecil)
        const historyQuery = await db.collectionGroup("history") 
            .where("trx_id", "==", reffid) 
            .limit(1)
            .get();

        if (historyQuery.empty) {
            console.log(`[WEBHOOK] Trx Not Found: ${reffid}`);
            return res.status(200).json({ ok: false, error: 'Trx Not Found' });
        }

        const docSnapshot = historyQuery.docs[0];
        const docRef = docSnapshot.ref;
        const currentData = docSnapshot.data();
        
        // Proteksi: Jangan proses jika status sudah final (Sukses/Gagal)
        if (['Sukses', 'Gagal'].includes(currentData.status)) {
            return res.status(200).json({ ok: true, msg: "Already Finalized" });
        }

        // 5. Jalankan Transaksi Database (Update Status & Refund)
        await db.runTransaction(async (t) => {
            // Struktur hirarki: users/{uid}/history/{trx_id}
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

            // Logika Refund Otomatis
            if (shouldRefund) {
                const currentBalance = parseInt(userDoc.data().balance) || 0;
                const refundAmount = parseInt(currentData.amount) || 0;
                
                t.update(userRef, { balance: currentBalance + refundAmount });
                updatePayload.api_msg = `REFUND: ${keterangan}`;
                console.log(`[REFUND SUCCESS] ${reffid} ke User: ${userDoc.id}`);
            }

            t.update(docRef, updatePayload);
        });

        return res.status(200).json({ ok: true, parsed: match.groups });

    } catch (error) {
        console.error('[CRITICAL ERROR]', error);
        return res.status(500).json({ ok: false, error: error.message });
    }
}
