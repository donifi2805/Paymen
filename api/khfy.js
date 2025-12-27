const admin = require('firebase-admin');

// Inisialisasi Firebase (Hanya sekali)
if (!admin.apps.length) {
    // Pastikan Environment Variable FIREBASE_SERVICE_ACCOUNT sudah diset di Vercel
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

// --- REGEX FLEXIBLE ---
// Menerima RefID huruf Besar/Kecil, Spasi tidak baku, dan format variatif
const RX = /RC=(?<reffid>[a-zA-Z0-9-]+)\s+TrxID=(?<trxid>\d+)\s+(?<produk>[A-Z0-9]+)\.(?<tujuan>\d+)\s+(?<status_text>[A-Za-z]+)\s*(?<keterangan>.+?)(?:\s+Saldo[\s\S]*?)?(?:\bresult=(?<status_code>\d+))?\s*>?$/i;

export default async function handler(req, res) {
    // 1. Tangkap Pesan (Support GET dan POST)
    const message = 
        (req.query && req.query.message) || 
        (req.body && req.body.message) || 
        null;

    if (!message) {
        return res.status(400).json({ ok: false, error: 'Message kosong' });
    }

    console.log('[WEBHOOK RAW]:', message);

    try {
        // 2. Parse Pesan dengan Regex
        const match = message.match(RX);
        
        if (!match || !match.groups) {
            console.log('[WEBHOOK] Format tidak dikenali:', message);
            // Tetap return 200 agar supplier tidak menganggap server error
            return res.status(200).json({ ok: false, error: 'Format tidak dikenali' });
        }

        const {
            reffid,         // Ini adalah TRX-ID dari database kita (Contoh: TRX-123)
            status_text,    // Sukses / Gagal
            status_code: statusCodeRaw,
        } = match.groups;

        const keterangan = (match.groups.keterangan || '').trim();

        // 3. Tentukan Status (0=Sukses, 1=Gagal/Refund)
        let status_code = null;
        if (statusCodeRaw != null) {
            status_code = Number(statusCodeRaw);
        } else {
            // Fallback jika result= tidak ada, baca dari teks
            if (/sukses/i.test(status_text)) status_code = 0;
            else if (/gagal|batal/i.test(status_text)) status_code = 1;
        }

        // 4. CARI TRANSAKSI DI DATABASE
        // PENTING: Menggunakan "history" (huruf kecil) sesuai permintaan & index Anda
        const historyQuery = await db.collectionGroup("history") 
            .where("trx_id", "==", reffid) 
            .limit(1)
            .get();

        // Jika transaksi tidak ditemukan
        if (historyQuery.empty) {
            console.log(`[WEBHOOK] Trx Not Found: ${reffid}`);
            return res.status(200).json({ ok: false, error: 'Trx Not Found' });
        }

        const docSnapshot = historyQuery.docs[0];
        const docRef = docSnapshot.ref;
        const currentData = docSnapshot.data();
        
        // Cek apakah sudah pernah diproses sebelumnya (Anti-Double)
        if (['Sukses', 'Gagal'].includes(currentData.status)) {
            return res.status(200).json({ ok: true, msg: "Already Finalized" });
        }

        // 5. UPDATE DATABASE & REFUND (Jika Gagal)
        await db.runTransaction(async (t) => {
            // Ambil data User pemilik transaksi (Parent of Parent)
            // Struktur: users/{uid}/history/{trx_id}
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

            // Data yang akan diupdate ke history
            let updatePayload = {
                status: newStatus,
                sn: keterangan,
                api_msg: `Webhook: ${status_text}`, // Simpan pesan asli supplier
                last_updated: admin.firestore.FieldValue.serverTimestamp(),
                raw_webhook_message: message
            };

            // Logika Refund Saldo
            if (shouldRefund) {
                const currentBalance = parseInt(userDoc.data().balance) || 0;
                const refundAmount = parseInt(currentData.amount) || 0;
                
                // Kembalikan saldo ke user
                t.update(userRef, { balance: currentBalance + refundAmount });
                
                updatePayload.api_msg = `REFUND: ${keterangan}`;
                console.log(`[REFUND] ${reffid} - Amount: ${refundAmount}`);
            }

            // Eksekusi Update History
            t.update(docRef, updatePayload);
        });

        return res.status(200).json({ ok: true, parsed: match.groups });

    } catch (error) {
        console.error('[ERROR SYSTEM]', error);
        // Return 500 jika error coding/server
        return res.status(500).json({ ok: false, error: error.message });
    }
}
