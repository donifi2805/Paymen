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
// Pastikan API Key dan URL ini benar
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

// --- 3. LOGIKA UTAMA (ADAPTASI PANEL ADMIN) ---
async function runPendingTransactions() {
    console.log(`[${new Date().toISOString()}] MEMULAI SCANNING...`);

    try {
        // PERUBAHAN PENTING: Menggunakan collectionGroup('history')
        // Ini akan mencari ke dalam SEMUA folder users/{uid}/history/
        // Sama persis seperti logika paneladmin.html
        
        const snapshot = await db.collectionGroup('history')
                                 .where('status', 'in', ['Pending', 'Proses']) 
                                 .get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada transaksi dengan status 'Pending' atau 'Proses' di seluruh database.");
            return;
        }

        console.log(`✅ DITEMUKAN ${snapshot.size} ANTRIAN PENDING. Memulai Eksekusi...`);

        // --- LOOPING EKSEKUSI ---
        for (const doc of snapshot.docs) {
            const trx = doc.data();
            const trxID = doc.id;
            
            // TEKNIK KHUSUS: Mengambil UID User dari path dokumen
            // Path format: users/{uid}/history/{trxID}
            const pathSegments = doc.ref.path.split('/');
            const uidUser = pathSegments[1]; // Segmen ke-1 adalah UID

            // Mapping Data (Sesuaikan dengan field di paneladmin: title, amount, dest_num/target)
            // Di paneladmin menggunakan: title, amount, dest_num, target, phone
            const skuProduk = trx.product_code || trx.code || trx.kode_produk; // Coba berbagai kemungkinan nama field
            let tujuan = trx.dest_num || trx.target || trx.nomor_tujuan || trx.phone || trx.no_hp;

            console.log(`\n🔹 Memproses TRX: ${trxID}`);
            console.log(`   User: ${uidUser}`);
            console.log(`   Produk: ${skuProduk} -> Tujuan: ${tujuan}`);

            if (!skuProduk || !tujuan) {
                console.log(`   ❌ Skip: Data produk atau nomor tujuan tidak lengkap.`);
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
                // Timeout 15 detik
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 15000); 

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
            // KHFY biasanya mengembalikan status: true atau success: true
            const isSuccess = (result.status === true || result.success === true);

            if (isSuccess) {
                // === JIKA SUKSES ===
                const snProvider = result.data?.sn || result.data?.catatan || "Proses Sukses Otomatis";
                const orderIdProvider = result.data?.id || '-';
                
                // UPDATE DATABASE (Ingat pathnya: users/{uid}/history/{trxID})
                await db.collection('users').doc(uidUser).collection('history').doc(trxID).update({
                    status: 'Sukses', // Huruf besar S sesuai paneladmin
                    api_msg: `Sukses Otomatis. SN: ${snProvider}`, // Menampilkan SN di kolom keterangan paneladmin
                    sn: snProvider,
                    trx_id_provider: orderIdProvider,
                    date_updated: new Date().toISOString()
                });
                
                // KIRIM NOTIFIKASI KE USER
                await sendUserLog(
                    uidUser, 
                    "Transaksi Berhasil", 
                    `Pesanan ${trx.title || skuProduk} berhasil. SN: ${snProvider}`, 
                    trxID
                );

                console.log(`   ✅ SUKSES: Data diupdate jadi 'Sukses'.`);

            } else {
                // === JIKA GAGAL DARI PROVIDER ===
                const pesanError = result.data?.pesan || result.message || "Unknown Error";
                console.log(`   ⏳ GAGAL PROVIDER: "${pesanError}".`);
                
                // LOGIKA KHUSUS:
                // Jika errornya "Saldo Habis" atau "Gangguan", kita biarkan PENDING (agar dicoba lagi nanti).
                // Tapi jika errornya "Nomor Salah" atau "Produk Close", sebaiknya digagalkan (Optional).
                // Untuk saat ini sesuai request Anda: KITA BIARKAN SAJA (Tetap Pending).
                console.log(`   ➡️ Transaksi dibiarkan 'Pending'.`);
            }

            // Jeda 2 detik (Rate Limit)
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        process.exit(1);
    }
    console.log("\n--- SELESAI ---");
}

runPendingTransactions();