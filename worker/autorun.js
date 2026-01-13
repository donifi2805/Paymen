const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE ---
try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
} catch (error) {
    console.error("GAGAL SETUP FIREBASE:", error.message);
    process.exit(1);
}

const db = admin.firestore();

// --- 2. KONFIGURASI PROVIDER ---
const PROVIDER_URL = "https://panel.khfy-store.com/api_v2"; 
const API_KEY_PROVIDER = process.env.KHFY_API_KEY; 

// --- FUNGSI TAMBAHAN: KIRIM NOTIFIKASI KE USER ---
async function sendUserLog(uid, title, message, trxId) {
    if (!uid) return;
    try {
        // Ini akan membuat notifikasi di folder user masing-masing
        // User bisa melihat ini di menu notifikasi aplikasi/web mereka
        await db.collection('users').doc(uid).collection('notifications').add({
            title: title,
            message: message,
            type: 'transaksi',
            trxId: trxId,
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`🔔 Notifikasi dikirim ke user: ${uid}`);
    } catch (e) {
        console.error("Gagal kirim notif ke user:", e.message);
    }
}

// --- 3. LOGIKA RETRY (COBA TERUS) ---
async function runPendingTransactions() {
    console.log(`[${new Date().toISOString()}] CEK TRANSAKSI PENDING...`);

    try {
        // Ambil transaksi pending (Limit 20)
        const snapshot = await db.collection('transaksi')
                                 .where('status', '==', 'pending') 
                                 .limit(20) 
                                 .get();

        if (snapshot.empty) {
            console.log('Tidak ada antrian pending saat ini.');
            return;
        }

        console.log(`Ditemukan ${snapshot.size} transaksi pending. Memulai proses...`);

        // Loop setiap transaksi pending
        for (const doc of snapshot.docs) {
            const trx = doc.data();
            const trxID = doc.id;
            
            const skuProduk = trx.produk; 
            const tujuan = trx.tujuan;    
            const uidUser = trx.uid; // Pastikan field ini ada di database transaksi Anda

            console.log(`\n--- Memproses TRX: ${trxID} (${skuProduk} -> ${tujuan}) ---`);

            // Validasi data minimal
            if (!skuProduk || !tujuan) {
                console.log(`❌ Data korup, dilewati.`);
                continue; 
            }

            // A. TEMBAK API PROVIDER
            const payload = {
                api_key: API_KEY_PROVIDER,
                action: 'order',
                service: skuProduk, 
                target: tujuan
            };
            
            let result;
            try {
                // Timeout controller (10 detik)
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 10000); 

                const response = await fetch(PROVIDER_URL, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: new URLSearchParams(payload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                result = await response.json();

            } catch (errApi) {
                console.error("⚠️ Koneksi Provider Error/Timeout. Skip dulu.");
                continue; 
            }

            console.log("Respon Provider:", JSON.stringify(result));

            // B. CEK HASIL
            const isSuccess = (result.status === true || result.success === true);

            if (isSuccess) {
                // === JIKA SUKSES ===
                const snProvider = result.data?.sn || result.data?.catatan || "Proses Sukses";
                const orderIdProvider = result.data?.id || '-';
                
                // 1. Update Transaksi (JANGAN DELETE)
                // Kita hanya ubah status jadi 'sukses'. Data tetap ada di Admin Panel (History).
                await db.collection('transaksi').doc(trxID).update({
                    status: 'sukses',
                    sn: snProvider,
                    order_id_provider: orderIdProvider,
                    tanggal_sukses: admin.firestore.FieldValue.serverTimestamp(),
                    // Tambahan log di dalam dokumen transaksi itu sendiri
                    keterangan: `Sukses diproses Otomatis. SN: ${snProvider}`
                });
                
                // 2. Kirim Log/Notifikasi ke System User
                if (uidUser) {
                    await sendUserLog(
                        uidUser, 
                        "Transaksi Berhasil", 
                        `Pesanan ${skuProduk} ke ${tujuan} BERHASIL. SN: ${snProvider}`, 
                        trxID
                    );
                }

                console.log(`✅ SUKSES! Status diupdate & Notif dikirim.`);

            } else {
                // === JIKA GAGAL DARI PROVIDER ===
                // Biarkan PENDING. Tidak ada perubahan database.
                // Tidak ada refund (karena status belum gagal).
                // Log error di console saja.
                
                const pesanError = result.data?.pesan || result.message || "Unknown Error";
                console.log(`⏳ GAGAL PROVIDER: "${pesanError}". Biarkan PENDING.`);
            }

            // Jeda 2 detik
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL SYSTEM ERROR:", error);
        process.exit(1);
    }
    console.log("\nSEMUA PROSES SELESAI.");
}

runPendingTransactions();
