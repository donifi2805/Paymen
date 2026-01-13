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

// --- FUNGSI NOTIFIKASI USER ---
async function sendUserLog(uid, title, message, trxId) {
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('notifications').add({
            title: title,
            message: message,
            type: 'transaksi',
            trxId: trxId,
            isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`🔔 Notif dikirim ke User ID: ${uid}`);
    } catch (e) {
        console.error("Gagal kirim notif:", e.message);
    }
}

// --- 3. LOGIKA UTAMA (ADAPTASI PANEL ADMIN V2) ---
async function runPendingTransactions() {
    console.log(`[${new Date().toISOString()}] MEMULAI SCANNING...`);

    try {
        // Cari di semua folder history milik user
        const snapshot = await db.collectionGroup('history')
                                 .where('status', 'in', ['Pending', 'Proses']) 
                                 .get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada transaksi pending.");
            return;
        }

        console.log(`✅ DITEMUKAN ${snapshot.size} ANTRIAN. Memulai Proses...`);

        for (const doc of snapshot.docs) {
            const trx = doc.data();
            const trxID = doc.id;
            
            // Ambil UID dari path dokumen (users/{UID}/history/{TRXID})
            const uidUser = doc.ref.path.split('/')[1];

            // --- PERBAIKAN UTAMA DISINI (MENGACU KE PANELADMIN.HTML) ---
            // Kita cek semua kemungkinan nama field yang dipakai di paneladmin
            
            // 1. Cek SKU Produk (Urutan prioritas berdasarkan renderTransactions di paneladmin)
            const skuProduk = trx.provider_code   // Cek field provider_code
                           || trx.raw_code        // Cek field raw_code
                           || trx.product_code    // Cek field product_code
                           || trx.code            // Cek field code
                           || trx.kode_produk     // Cek field kode_produk
                           || trx.sku;            // Jaga-jaga

            // 2. Cek Nomor Tujuan (Urutan prioritas berdasarkan renderTransactions di paneladmin)
            let tujuan = trx.dest_num          // Cek field dest_num
                      || trx.target            // Cek field target
                      || trx.nomor_tujuan      // Cek field nomor_tujuan
                      || trx.no_hp             // Cek field no_hp
                      || trx.phone             // Cek field phone
                      || trx.customer_no       // Cek field customer_no
                      || trx.pelanggan;        // Cek field pelanggan

            console.log(`\n🔹 Memproses TRX: ${trxID}`);
            
            // Debugging: Tampilkan apa yang terbaca jika masih gagal
            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP!`);
                console.log(`   Isi Data Database:`, JSON.stringify(trx)); // Supaya Anda bisa lihat field aslinya apa
                continue; 
            }

            console.log(`   Produk: ${skuProduk} -> Tujuan: ${tujuan}`);

            // A. TEMBAK API PROVIDER
            const payload = {
                api_key: API_KEY_PROVIDER,
                action: 'order',
                service: skuProduk, 
                target: tujuan
            };
            
            let result;
            try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 detik

                const response = await fetch(PROVIDER_URL, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
                    body: new URLSearchParams(payload),
                    signal: controller.signal
                });
                clearTimeout(timeoutId);
                result = await response.json();

            } catch (errApi) {
                console.error("   ⚠️ Error Koneksi Provider (Timeout/Network). Skip dulu.");
                continue; 
            }

            console.log("   📡 Respon Provider:", JSON.stringify(result));

            // B. CEK HASIL
            const isSuccess = (result.status === true || result.success === true);

            if (isSuccess) {
                const snProvider = result.data?.sn || result.data?.catatan || "Proses Sukses Otomatis";
                const orderIdProvider = result.data?.id || '-';
                
                await db.collection('users').doc(uidUser).collection('history').doc(trxID).update({
                    status: 'Sukses',
                    api_msg: `Sukses Otomatis. SN: ${snProvider}`,
                    sn: snProvider,
                    trx_id_provider: orderIdProvider,
                    date_updated: new Date().toISOString()
                });
                
                await sendUserLog(uidUser, "Transaksi Berhasil", `Order ${skuProduk} sukses. SN: ${snProvider}`, trxID);
                console.log(`   ✅ SUKSES DIUPDATE.`);

            } else {
                const pesanError = result.data?.pesan || result.message || "Unknown Error";
                console.log(`   ⏳ GAGAL PROVIDER: "${pesanError}". Tetap Pending.`);
            }

            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        process.exit(1);
    }
    console.log("\n--- SELESAI ---");
}

runPendingTransactions();