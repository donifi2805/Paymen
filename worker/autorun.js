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

// --- FUNGSI CEK STATUS (KHUSUS RE-CHECK) ---
async function cekStatusProvider(refIdLokal, trxIdProvider) {
    // Kita cek menggunakan RefID Lokal atau ID dari Provider
    const payload = {
        api_key: API_KEY_PROVIDER,
        action: 'history', // Action cek riwayat di Khfy
        ref_id: refIdLokal // Menggunakan ID Transaksi kita
    };

    try {
        const response = await fetch(PROVIDER_URL, {
            method: 'POST',
            headers: {'Content-Type': 'application/x-www-form-urlencoded'},
            body: new URLSearchParams(payload)
        });
        const result = await response.json();
        return result;
    } catch (error) {
        console.log("⚠️ Gagal Re-Check Status:", error.message);
        return null;
    }
}

// --- 3. LOGIKA UTAMA ---
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
            
            // Ambil UID User dari path
            const uidUser = doc.ref.path.split('/')[1];

            // --- PERBAIKAN 1: MAPPING FIELD SUPER LENGKAP (Sesuai paneladmin.html) ---
            // Cek semua kemungkinan nama field agar tidak undefined
            const skuProduk = trx.provider_code || trx.raw_code || trx.product_code || trx.code || trx.kode_produk || trx.sku || trx.buyer_sku_code;
            
            let tujuan = trx.dest_num || trx.target || trx.nomor_tujuan || trx.no_hp || trx.phone || trx.customer_no || trx.pelanggan || trx.tujuan;

            console.log(`\n🔹 Memproses TRX: ${trxID}`);
            
            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP (Undefined).`);
                console.log(`   Isi Data DB:`, JSON.stringify(trx)); 
                continue; 
            }

            console.log(`   Produk: ${skuProduk} -> Tujuan: ${tujuan}`);

            // A. TEMBAK ORDER KE PROVIDER
            const payload = {
                api_key: API_KEY_PROVIDER,
                action: 'order',
                service: skuProduk, 
                target: tujuan,
                ref_id: trxID // Kirim ID kita agar mudah dilacak
            };
            
            let result;
            try {
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
                console.error("   ⚠️ Error Koneksi Provider. Skip.");
                continue; 
            }

            console.log("   📡 Respon Awal Provider:", JSON.stringify(result));

            // B. ANALISA HASIL ORDER
            const isOrderAccepted = (result.status === true || result.success === true);
            const trxIdProvider = result.data?.id || result.data?.trxid || '-';

            if (isOrderAccepted) {
                console.log(`   ✅ Order Diterima Provider. ID Pusat: ${trxIdProvider}`);
                console.log(`   ⏳ Menunggu 6 detik untuk Cek Status Final...`);

                // --- PERBAIKAN 2: JEDA 6 DETIK LALU CEK STATUS ---
                await new Promise(r => setTimeout(r, 6000)); 

                // Lakukan Pengecekan Ulang (Re-Check)
                const checkResult = await cekStatusProvider(trxID, trxIdProvider);
                
                let finalStatus = 'Pending'; // Default
                let finalSN = result.data?.sn || '';
                let finalMsg = result.data?.message || 'Menunggu Provider';

                if (checkResult && checkResult.data) {
                    // Parsing hasil Re-check (Khfy biasanya mengembalikan array data atau object data)
                    let dataCek = checkResult.data;
                    if (Array.isArray(dataCek)) dataCek = dataCek[0]; // Ambil data pertama jika array
                    else if (dataCek.data && Array.isArray(dataCek.data)) dataCek = dataCek.data[0];

                    if (dataCek) {
                        const statusPusat = (dataCek.status || '').toUpperCase();
                        finalSN = dataCek.sn || dataCek.catatan || finalSN;
                        
                        console.log(`   🔎 Hasil Re-Check: ${statusPusat} | SN: ${finalSN}`);

                        if (statusPusat.includes('SUKSES')) {
                            finalStatus = 'Sukses';
                        } else if (statusPusat.includes('GAGAL') || statusPusat.includes('ERROR')) {
                            // Opsional: Ubah jadi Gagal jika provider bilang gagal
                            // finalStatus = 'Gagal'; 
                        }
                    }
                }

                // C. UPDATE DATABASE BERDASARKAN HASIL AKHIR
                if (finalStatus === 'Sukses') {
                    await db.collection('users').doc(uidUser).collection('history').doc(trxID).update({
                        status: 'Sukses',
                        api_msg: `Sukses Otomatis. SN: ${finalSN}`,
                        sn: finalSN,
                        trx_id_provider: trxIdProvider,
                        date_updated: new Date().toISOString()
                    });
                    
                    await sendUserLog(uidUser, "Transaksi Berhasil", `Order ${skuProduk} sukses. SN: ${finalSN}`, trxID);
                    console.log(`   🎉 TRANSAKSI SELESAI (SUKSES).`);
                } else {
                    // Jika masih pending setelah 6 detik, update info saja, biarkan status Pending
                    // Supaya Cronjob berikutnya mengecek lagi.
                    await db.collection('users').doc(uidUser).collection('history').doc(trxID).update({
                        trx_id_provider: trxIdProvider,
                        api_msg: `Sedang diproses Provider... SN: ${finalSN}`,
                        date_updated: new Date().toISOString()
                    });
                    console.log(`   🕒 Masih Pending/Proses. Akan dicek lagi nanti.`);
                }

            } else {
                // Jika Order Ditolak Langsung (Misal Saldo Kurang / Gangguan)
                const pesanError = result.data?.pesan || result.message || "Unknown Error";
                console.log(`   ❌ ORDER DITOLAK: "${pesanError}".`);
                
                // Update keterangan error tapi biarkan status Pending (sesuai request Anda sebelumnya)
                // Agar tidak refund otomatis.
            }

            // Jeda antar user agar tidak spamming
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        process.exit(1);
    }
    console.log("\n--- SELESAI ---");
}

runPendingTransactions();