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

// --- 2. KONFIGURASI RELAY VERCEL ---
const VERCEL_DOMAIN = "https://www.pandawa-digital.store";
const KHFY_KEY = process.env.KHFY_API_KEY;
const ICS_KEY = process.env.ICS_API_KEY;

// --- HELPER: SAFE FETCH (ANTI CRASH & TIMEOUT) ---
async function safeFetchRelay(url, method = 'GET', body = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); // Timeout 60 detik

    try {
        const options = {
            method: method,
            headers: { 
                'User-Agent': 'Pandawa-Worker/2.0',
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        };
        
        // Vercel Relay Anda menggunakan GET query params untuk KHFY, tapi POST support juga
        if (body && method === 'POST') options.body = JSON.stringify(body);

        const response = await fetch(url, options);
        clearTimeout(timeout);

        // Cek Tipe Konten (Jaga-jaga jika Vercel/Server Pusat melempar HTML Error)
        const contentType = response.headers.get("content-type");
        const text = await response.text();

        if (!contentType || !contentType.includes("application/json")) {
            // Deteksi HTML Error (Bad Gateway / Maintenance)
            return { 
                ok: false, 
                isHtmlError: true, 
                msg: `Respon Server Bukan JSON (HTML/Maintenance). Raw: ${text.substring(0, 50)}...` 
            };
        }

        try {
            const json = JSON.parse(text);
            return { ok: true, data: json };
        } catch (e) {
            return { ok: false, msg: "Gagal Parsing JSON", raw: text.substring(0, 50) };
        }

    } catch (error) {
        clearTimeout(timeout);
        return { ok: false, msg: `Network Error/Timeout: ${error.message}` };
    }
}

// --- FUNGSI CEK STOK MASSAL ---
async function getKHFYStockList() {
    console.log("      📋 Mengambil Data Stok KHFY...");
    const params = new URLSearchParams();
    params.append('api_key', KHFY_KEY);
    params.append('endpoint', '/list_product');
    params.append('produk', 'LIST');
    params.append('tujuan', 'LIST');
    params.append('reff_id', 'CHECK-STOCK');

    const targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;

    const result = await safeFetchRelay(targetUrl, 'GET');

    if (result.ok && result.data && result.data.data && Array.isArray(result.data.data)) {
        const stockMap = {};
        result.data.data.forEach(item => {
            stockMap[item.kode_produk] = {
                gangguan: item.gangguan,
                kosong: item.kosong
            };
        });
        console.log(`      📋 Berhasil memuat ${result.data.data.length} data produk KHFY.`);
        return stockMap;
    } else {
        console.error("      ⚠️ Gagal ambil stok KHFY:", result.msg || "Data Kosong");
        return null;
    }
}

// --- FUNGSI TEMBAK KE RELAY (TRANSAKSI) ---
async function hitVercelRelay(serverType, data, isRecheck = false) {
    let targetUrl = '';
    const params = new URLSearchParams();

    // Setup URL & Params
    if (serverType === 'ICS') {
        if (isRecheck) params.append('action', 'checkStatus');
        else params.append('action', 'createTransaction');
        
        params.append('apikey', ICS_KEY);
        params.append('kode_produk', data.sku);
        params.append('nomor_tujuan', data.tujuan);
        params.append('refid', data.reffId);
        
        targetUrl = `${VERCEL_DOMAIN}/api/relay?${params.toString()}`;
    } else {
        // KHFY
        params.append('api_key', KHFY_KEY);
        if (isRecheck) params.append('endpoint', '/history');
        else params.append('endpoint', '/trx');
        
        params.append('produk', data.sku);
        params.append('tujuan', data.tujuan);
        params.append('reff_id', data.reffId);
        
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    if (!isRecheck) console.log(`      🚀 Menembak Relay Vercel (${serverType})...`);
    
    // Eksekusi Fetch Aman
    const result = await safeFetchRelay(targetUrl, 'GET');

    // Normalisasi Return agar sesuai logika lama Anda
    if (result.ok) {
        return result.data; // Kembalikan JSON asli provider
    } else {
        return { 
            status: false, 
            success: false, 
            message: result.msg || "Koneksi Gagal/Timeout",
            is_network_error: true // Flag khusus
        };
    }
}

// --- FUNGSI NOTIFIKASI ---
async function sendUserLog(uid, title, message, trxId) {
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('notifications').add({
            title, message, type: 'transaksi', trxId, isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { console.error("Err Notif:", e.message); }
}

// --- 3. LOGIKA UTAMA ---
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI CEK PREORDER QUEUE...`);

    try {
        // Ambil antrian terlama dulu (FIFO)
        const snapshot = await db.collection('preorders')
                                 .orderBy('timestamp', 'asc') 
                                 .limit(50) // Batasi agar tidak timeout function
                                 .get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian.");
            return;
        }

        console.log(`✅ DITEMUKAN ${snapshot.size} DATA. Memproses...`);
        const stockMap = await getKHFYStockList();

        for (const doc of snapshot.docs) {
            const po = doc.data();
            const poID = doc.id;
            const uidUser = po.uid; 
            
            // Fallback nama field (jaga-jaga beda versi frontend)
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            const serverType = po.serverType || 'KHFY'; 
            
            // Reff ID Unik
            const reffId = po.order_id || `AUTO-${Date.now()}-${Math.floor(Math.random()*1000)}`;

            console.log(`\n🔹 TRX: ${poID} | ${skuProduk} -> ${tujuan} (${serverType})`);

            // 1. VALIDASI DATA
            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP. Hapus.`);
                await db.collection('preorders').doc(poID).delete(); 
                continue; 
            }

            // 2. CEK STOK LOKAL (KHFY Only)
            if (serverType === 'KHFY' && stockMap && stockMap[skuProduk]) {
                const infoProduk = stockMap[skuProduk];
                if (infoProduk.gangguan === 1 || infoProduk.kosong === 1) {
                    const statusMsg = infoProduk.gangguan === 1 ? 'SEDANG GANGGUAN' : 'STOK KOSONG';
                    console.log(`   ⛔ SKIP (Pre-Check): Produk ${skuProduk} ${statusMsg}.`);
                    await db.collection('preorders').doc(poID).update({
                        debugLogs: `[${new Date().toLocaleTimeString()}] [SKIP-HEMAT] ${statusMsg}`
                    });
                    continue; 
                }
            }

            // 3. HIT RELAY (Create Transaction)
            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            let result = await hitVercelRelay(serverType, requestData, false);
            
            // 4. WAIT LOGIC (KHFY Only) - Double Check
            if (serverType !== 'ICS') {
                const msgAwal = (result.msg || result.message || '').toLowerCase();
                const isQueued = msgAwal.includes('proses') || msgAwal.includes('berhasil') || (result.data && result.data.status_text === 'PROSES');
                
                // Jika KHFY bilang "Proses", kita tunggu sebentar lalu cek history
                if (!result.is_network_error && isQueued) {
                    console.log(`      ⏳ Respon: "Diproses". Menunggu 6 detik untuk Cek Status...`);
                    await new Promise(r => setTimeout(r, 6000));
                    
                    const checkResult = await hitVercelRelay(serverType, requestData, true);
                    // Jika hasil cek status valid, gunakan itu sebagai hasil akhir
                    if (checkResult && !checkResult.is_network_error && checkResult.data) {
                        result = checkResult; 
                        console.log("      ✅ Status Terupdate dari History.");
                    }
                }
            }
            
            // console.log("      📡 Respon Final:", JSON.stringify(result).substring(0, 100) + "...");

            // 5. ANALISA HASIL FINAL
            let isSuccess = false;
            let finalMessage = '-';
            let finalSN = '-';
            let trxIdProvider = '-';
            let isStockEmpty = false;
            let isNetworkFail = false; // Flag baru untuk retry

            // --- ANALISA ICS ---
            if (serverType === 'ICS') {
                if (result.is_network_error) {
                    isNetworkFail = true;
                    finalMessage = result.message;
                } else if (result.success === true && result.data) {
                    if (result.data.status === 'success') {
                        isSuccess = true;
                        finalMessage = result.data.message || 'Transaksi Berhasil'; 
                        finalSN = result.data.sn || '-'; 
                        trxIdProvider = result.data.refid || '-';
                    } else if (result.data.status === 'failed') {
                        const msg = (result.data.message || '').toLowerCase();
                        finalMessage = result.data.message;
                        if (msg.includes('kosong') || msg.includes('ditutup') || msg.includes('stok')) {
                            isStockEmpty = true;
                        }
                    } else {
                        finalMessage = result.data.message || 'Pending ICS';
                    }
                } else {
                    finalMessage = result.message || 'Gagal ICS (Unknown)';
                }

            // --- ANALISA KHFY ---
            } else {
                if (result.is_network_error) {
                    isNetworkFail = true;
                    finalMessage = result.message;
                } else {
                    let dataItem = null;
                    if (result.data) {
                        if (Array.isArray(result.data)) dataItem = result.data[0];
                        else dataItem = result.data;
                    }

                    // Ambil status text
                    const statusText = dataItem ? (dataItem.status_text || '') : '';
                    const msg = (result.msg || result.message || '').toLowerCase();
                    
                    if (statusText === 'SUKSES') {
                        isSuccess = true;
                        trxIdProvider = dataItem.kode || dataItem.trxid || '-';
                        finalSN = dataItem.sn || '-';
                        finalMessage = `${statusText}. SN: ${finalSN}`;
                    } else if (statusText === 'GAGAL' || msg.includes('stok kosong') || msg.includes('gagal')) {
                         finalMessage = dataItem ? dataItem.keterangan : msg;
                         if (finalMessage.toLowerCase().includes('kosong')) isStockEmpty = true;
                    } else {
                        finalMessage = dataItem ? (dataItem.keterangan || 'Sedang Diproses') : (msg || 'Pending');
                    }
                }
            }

            // 6. DATABASE ACTION
            if (isSuccess) {
                console.log(`   ✅ SUKSES: ${finalMessage}`);
                
                const historyId = po.historyId || `TRX-${Date.now()}`;
                
                let finalTitle = po.productName || skuProduk;
                if (!finalTitle.toLowerCase().includes('preorder')) {
                    finalTitle = `[PreOrder] ${finalTitle}`;
                }

                // Simpan ke History User
                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser, 
                    trx_id: reffId, 
                    trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    title: finalTitle, 
                    type: 'out', 
                    amount: po.price || 0, 
                    status: 'Sukses',
                    dest_num: tujuan, 
                    sn: finalSN, 
                    trx_id_provider: trxIdProvider, 
                    provider_code: skuProduk,
                    date: new Date().toISOString(), 
                    api_msg: finalMessage, 
                    balance_before: 0, 
                    balance_after: 0,
                    is_preorder: true, 
                    raw_provider_json: JSON.stringify(result), 
                    provider_source: serverType
                }, { merge: true }); // Merge agar aman

                // Kirim Notif & Hapus Antrian
                await sendUserLog(uidUser, "PreOrder Berhasil", `Sukses: ${finalTitle}`, historyId);
                console.log(`   🗑️ Menghapus dari antrian Preorder...`);
                await db.collection('preorders').doc(poID).delete();

            } else if (isStockEmpty) {
                console.log(`   ⚠️ GAGAL STOK KOSONG: ${finalMessage}`);
                // Tetap di antrian, update log
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] [STOK KOSONG] ${finalMessage}`
                });

            } else if (isNetworkFail) {
                console.log(`   🔌 NETWORK ERROR (RETRY LATER): ${finalMessage}`);
                // Jangan lakukan apa-apa, biarkan dicoba lagi nanti
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] [RETRY NETWORK] ${finalMessage}`
                });

            } else {
                console.log(`   ⏳ PENDING/GAGAL PROVIDER: ${finalMessage}`);
                // Update log retry
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] [RETRY LOGIC] ${finalMessage}`
                });
            }

            // Delay sedikit antar transaksi agar tidak spamming banget
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL RUNTIME ERROR:", error);
        // Jangan process.exit(1) di sini agar worker tetap hidup untuk jadwal berikutnya jika pakai setInterval
    }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();