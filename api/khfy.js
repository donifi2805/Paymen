const admin = require('firebase-admin');

// Inisialisasi Firebase
if (!admin.apps.length) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// --- REGEX DARI KHFY ---
// Menangkap: reffid (trx_id kita), trxid (pusat), produk, tujuan, status, dll
const RX = /RC=(?<reffid>[a-f0-9-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)\s*(?<keterangan>.+?)(?:\s+Saldo[\s\S]*?)?(?:\bresult=(?<status_code>\d+))?\s*>?$/i;

export default async function handler(req, res) {
    try {
        // 1. Ambil Message (Bisa dari GET Query atau POST Body)
        const message = 
            (req.query && req.query.message) || 
            (req.body && req.body.message) || 
            null;

        if (!message) {
            console.log('[WEBHOOK] Message kosong');
            return res.status(400).json({ ok: false, error: 'message kosong' });
        }

        console.log('[WEBHOOK RAW]:', message);

        // 2. Parse Menggunakan Regex
        const match = message.match(RX);
        
        if (!match || !match.groups) {
            console.log('[WEBHOOK] Format tidak dikenali');
            // Tetap return 200 agar Khfy tidak mengulang kirim terus menerus
            return res.status(200).json({ ok: false, error: 'format tidak dikenali' });
        }

        const {
            reffid,      // Ini adalah Trx ID Lokal kita (misal: TRX-123...)
            trxid,       // ID dari Pusat
            status_text,
            status_code: statusCodeRaw,
        } = match.groups;

        const keterangan = (match.groups.keterangan || '').trim();

        // 3. Tentukan Status (0=Sukses, 1=Gagal)
        let status_code = null;
        if (statusCodeRaw != null) {
            status_code = Number(statusCodeRaw);
        } else {
            // Fallback jika tidak ada result=...
            if (/sukses/i.test(status_text)) status_code = 0;
            else if (/gagal|batal/i.test(status_text)) status_code = 1;
        }

        // 4. Cari Transaksi di Database
        // Kita cari berdasarkan 'trx_id' yang sama dengan 'reffid' dari Khfy
        const historyQuery = await db.collectionGroup("history")
            .where("trx_id", "==", reffid) 
            .limit(1)
            .get();

        if (historyQuery.empty) {
            console.log(`[SKIP] Transaksi lokal tidak ditemukan: ${reffid}`);
            return res.status(200).json({ ok: false, error: 'Trx Not Found' });
        }

        const docSnapshot = historyQuery.docs[0];
        const docRef = docSnapshot.ref;
        const currentData = docSnapshot.data();
        
        // Cek jika status sudah final, jangan proses lagi
        if (['Sukses', 'Gagal'].includes(currentData.status)) {
            return res.status(200).json({ ok: true, msg: "Already Finalized" });
        }

        // 5. Eksekusi Update & Auto Refund
        await db.runTransaction(async (t) => {
            const userRef = docRef.parent.parent; // Masuk ke User pemilik transaksi
            const userDoc = await t.get(userRef);
            
            if (!userDoc.exists) throw "User Data Missing";

            let newStatus = 'Pending';
            let shouldRefund = false;

            // Logika Status
            if (status_code === 0) {
                newStatus = 'Sukses';
            } else if (status_code === 1) {
                newStatus = 'Gagal';
                shouldRefund = true;
            }

            // Data untuk diupdate ke History
            let updatePayload = {
                status: newStatus,
                sn: keterangan, // Keterangan Khfy biasanya berisi SN
                api_msg: `Webhook: ${status_text} (RC=${status_code})`,
                last_updated: admin.firestore.FieldValue.serverTimestamp(),
                raw_webhook_message: message // Simpan pesan asli buat debug
            };

            // Logika Refund
            if (shouldRefund) {
                const currentBalance = parseInt(userDoc.data().balance) || 0;
                const refundAmount = parseInt(currentData.amount) || 0;
                
                // Kembalikan Saldo
                t.update(userRef, { balance: currentBalance + refundAmount });
                
                updatePayload.api_msg = `REFUND: ${keterangan}`;
                updatePayload.balance_final = currentBalance + refundAmount;
            }

            // Update Transaksi
            t.update(docRef, updatePayload);
        });

        console.log(`[UPDATE] ${reffid} -> ${status_code === 0 ? 'Sukses' : 'Gagal'}`);
        return res.status(200).json({ ok: true, parsed: match.groups });

    } catch (error) {
        console.error('[ERROR]', error);
        return res.status(500).json({ ok: false, error: error.message });
    }
}