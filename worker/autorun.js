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
const PROVIDER_BASE_URL = "https://panel.khfy-store.com/api_v2"; 
const API_KEY_PROVIDER = process.env.KHFY_API_KEY; 

// --- DAFTAR JALUR (PROXY LIST) ---
// Script akan mencoba jalur ini satu per satu sampai tembus
const PROXY_LIST = [
    { name: 'Direct', prefix: '' }, // Coba langsung dulu
    { name: 'CodeTabs', prefix: 'https://api.codetabs.com/v1/proxy?quest=' }, // Jalur Eropa
    { name: 'AllOrigins', prefix: 'https://api.allorigins.win/raw?url=' }, // Jalur Umum
    { name: 'CorsProxy', prefix: 'https://corsproxy.io/?' } // Jalur Cadangan
];

// --- FUNGSI REQUEST SAKTI (AUTO-SWITCH JALUR) ---
async function fetchWithRetry(endpoint, payload) {
    // Tambahkan Timestamp agar tidak dicache proxy
    const targetUrl = `${PROVIDER_BASE_URL}${endpoint}`;
    
    // Convert payload ke URLEncoded string
    const bodyParams = new URLSearchParams(payload).toString();

    for (const proxy of PROXY_LIST) {
        // Jika pakai proxy, target URL harus di-encode
        const finalUrl = proxy.name === 'Direct' 
            ? targetUrl 
            : proxy.prefix + encodeURIComponent(targetUrl);

        try {
            console.log(`      Trying via ${proxy.name}...`);
            
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 Detik Timeout (Lebih lama)

            // Khusus Proxy GET, kita akali POST-nya (Provider PPOB kadang strict POST)
            // Tapi karena GitHub Action IP-nya diblok, kita utamakan Proxy yang support POST
            // Atau jika provider support GET, kita ubah methodnya.
            // DISINI KITA PAKAI POST STANDAR TAPI LEWAT PROXY
            
            const response = await fetch(finalUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
                },
                body: bodyParams,
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (response.ok) {
                const text = await response.text();
                try {
                    const json = JSON.parse(text);
                    return { success: true, data: json, via: proxy.name };
                } catch (e) {
                    // Jika return bukan JSON, berarti proxy error
                    if (proxy.name === 'Direct') continue; // Coba next
                }
            }
        } catch (error) {
            // Lanjut ke proxy berikutnya
        }
    }
    return { success: false, message: "Semua jalur proxy gagal/timeout." };
}

// --- FUNGSI NOTIFIKASI ---
async function sendUserLog(uid, title, message, trxId) {
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('notifications').add({
            title: title, message: message, type: 'transaksi', trxId: trxId, isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { console.error("Err Notif:", e.message); }
}

// --- LOGIKA UTAMA ---
async function runPendingTransactions() {
    console.log(`[${new Date().toISOString()}] SCANNING...`);

    try {
        const snapshot = await db.collectionGroup('history')
                                 .where('status', 'in', ['Pending', 'Proses']) 
                                 .get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada transaksi pending.");
            return;
        }

        console.log(`✅ DITEMUKAN ${snapshot.size} ANTRIAN.`);

        for (const doc of snapshot.docs) {
            const trx = doc.data();
            const trxID = doc.id;
            const uidUser = doc.ref.path.split('/')[1];

            // Mapping Data
            const skuProduk = trx.provider_code || trx.raw_code || trx.product_code || trx.code || trx.kode_produk || trx.sku || trx.buyer_sku_code;
            const tujuan = trx.dest_num || trx.target || trx.nomor_tujuan || trx.no_hp || trx.phone || trx.customer_no || trx.pelanggan || trx.tujuan;

            console.log(`\n🔹 TRX: ${trxID} | ${skuProduk} -> ${tujuan}`);

            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA UNDEFINED. Skip.`);
                continue; 
            }

            // A. EKSEKUSI ORDER (PAKAI FETCH SAKTI)
            const payload = {
                api_key: API_KEY_PROVIDER,
                action: 'order',
                service: skuProduk, 
                target: tujuan,
                ref_id: trxID 
            };
            
            // Panggil fungsi Fetch yang sudah pakai Proxy Rotator
            const resultWrapper = await fetchWithRetry('', payload);

            if (!resultWrapper.success) {
                console.log(`   ⚠️ Gagal Koneksi (Semua Proxy Timeout).`);
                continue; // Skip, coba lagi nanti
            }

            const result = resultWrapper.data;
            console.log(`   📡 Respon (${resultWrapper.via}):`, JSON.stringify(result));

            // B. ANALISA HASIL
            const isSuccess = (result.status === true || result.success === true);
            const trxIdProvider = result.data?.id || result.data?.trxid || '-';

            if (isSuccess) {
                console.log(`   ✅ Order Diterima. ID: ${trxIdProvider}`);
                console.log(`   ⏳ Menunggu 6 detik untuk Re-Check...`);

                await new Promise(r => setTimeout(r, 6000)); 

                // RE-CHECK STATUS (Pakai Proxy Juga)
                const checkPayload = { api_key: API_KEY_PROVIDER, action: 'history', ref_id: trxID };
                const checkWrapper = await fetchWithRetry('', checkPayload);
                
                let finalSN = result.data?.sn || '';
                let finalStatus = 'Pending';

                if (checkWrapper.success && checkWrapper.data) {
                    let d = checkWrapper.data.data; // Khfy format
                    if (Array.isArray(d)) d = d[0];
                    
                    if (d) {
                        const st = (d.status || '').toUpperCase();
                        finalSN = d.sn || d.catatan || finalSN;
                        console.log(`   🔎 Re-Check Status: ${st} | SN: ${finalSN}`);
                        
                        if (st.includes('SUKSES')) finalStatus = 'Sukses';
                    }
                }

                if (finalStatus === 'Sukses') {
                    await db.collection('users').doc(uidUser).collection('history').doc(trxID).update({
                        status: 'Sukses',
                        api_msg: `Sukses Otomatis. SN: ${finalSN}`,
                        sn: finalSN,
                        trx_id_provider: trxIdProvider,
                        date_updated: new Date().toISOString()
                    });
                    await sendUserLog(uidUser, "Transaksi Berhasil", `Order ${skuProduk} Sukses. SN: ${finalSN}`, trxID);
                    console.log(`   🎉 SELESAI (SUKSES).`);
                } else {
                    await db.collection('users').doc(uidUser).collection('history').doc(trxID).update({
                        trx_id_provider: trxIdProvider,
                        api_msg: `Proses Provider... SN: ${finalSN}`,
                        date_updated: new Date().toISOString()
                    });
                    console.log(`   🕒 Masih Pending.`);
                }

            } else {
                const msg = result.data?.pesan || result.message || "Gagal";
                console.log(`   ❌ DITOLAK: ${msg}`);
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