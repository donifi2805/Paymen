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

// --- FUNGSI CEK STOK MASSAL (HEMAT KUOTA) ---
async function getKHFYStockList() {
    console.log("      📋 Mengambil Data Stok KHFY...");
    const params = new URLSearchParams();
    params.append('api_key', KHFY_KEY);
    params.append('endpoint', '/list_product'); 
    params.append('produk', 'LIST'); 
    params.append('tujuan', 'LIST');
    params.append('reff_id', 'CHECK-STOCK');

    const targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); 

        const response = await fetch(targetUrl, { 
            method: 'GET',
            headers: { 'User-Agent': 'Pandawa-Worker/1.0' },
            signal: controller.signal 
        });
        clearTimeout(timeoutId);

        const json = await response.json();
        const stockMap = {};
        
        if (json && json.data && Array.isArray(json.data)) {
            json.data.forEach(item => {
                stockMap[item.kode_produk] = {
                    gangguan: item.gangguan, 
                    kosong: item.kosong      
                };
            });
            console.log(`      📋 Berhasil memuat ${json.data.length} data produk KHFY.`);
            return stockMap;
        }
        return null; 
    } catch (error) {
        console.error("      ⚠️ Gagal ambil stok KHFY:", error.message);
        return null; 
    }
}

// --- FUNGSI TEMBAK KE RELAY (TRANSAKSI) ---
async function hitVercelRelay(serverType, data, isRecheck = false) {
    let targetUrl = '';
    const params = new URLSearchParams();

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
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); 

        const response = await fetch(targetUrl, { 
            method: 'GET',
            headers: { 'User-Agent': 'Pandawa-Worker/1.0' },
            signal: controller.signal 
        });
        clearTimeout(timeoutId);

        const text = await response.text();
        try {
            // Kita kembalikan Objek JSON asli agar nanti bisa di-stringify
            return JSON.parse(text);
        } catch (e) {
            return { status: false, message: "HTML Error / Server Pusat Gangguan", raw: text };
        }
    } catch (error) {
        return { status: false, message: "Relay Timeout" };
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
        const snapshot = await db.collection('preorders')
                                 .orderBy('timestamp', 'asc') 
                                 .limit(100) 
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
            
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            const serverType = po.serverType || 'KHFY'; 
            const reffId = `AUTO-${Date.now()}`;

            console.log(`\n🔹 TRX: ${poID} | ${skuProduk} -> ${tujuan}`);

            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP.`);
                // Data rusak dihapus saja agar tidak nyangkut
                await db.collection('preorders').doc(poID).delete(); 
                continue; 
            }

            // CEK STOK LOKAL
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

            // HIT RELAY
            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            // result menampung Objek JSON mentah dari Relay
            let result = await hitVercelRelay(serverType, requestData, false);
            
            // WAIT LOGIC (KHFY)
            if (serverType !== 'ICS') {
                const msgAwal = (result.msg || result.message || '').toLowerCase();
                const isQueued = msgAwal.includes('proses') || msgAwal.includes('berhasil');
                
                if (result.ok === true && isQueued) {
                    console.log(`      ⏳ Respon: "Akan Diproses". Menunggu 6 detik...`);
                    await new Promise(r => setTimeout(r, 6000));
                    const checkResult = await hitVercelRelay(serverType, requestData, true);
                    if (checkResult.ok === true || checkResult.data) result = checkResult; 
                }
            }
            
            console.log("      📡 Respon Final:", JSON.stringify(result));

            // ANALISA HASIL
            let isSuccess = false;
            let finalMessage = '-';
            let finalSN = '-';
            let trxIdProvider = '-';
            let isStockEmpty = false;
            let detailedErrorLog = ''; 

            if (serverType === 'ICS') {
                if (result.success === true && result.data) {
                    if (result.data.status === 'success') {
                        isSuccess = true;
                        finalMessage = result.data.message; 
                        finalSN = result.data.sn || '-'; 
                        trxIdProvider = result.data.refid || '-';
                    } 
                    else if (result.data.status === 'failed') {
                        const msg = (result.data.message || '').toLowerCase();
                        if (msg.includes('kosong') || msg.includes('ditutup')) {
                            isStockEmpty = true;
                            detailedErrorLog = `[STOK KOSONG] ${result.data.message}`;
                            finalMessage = result.data.message;
                        }
                    }
                } 
                if (!isSuccess && !isStockEmpty) finalMessage = result.message || (result.data ? result.data.message : 'Gagal ICS');

            } else {
                // KHFY Logic
                let dataItem = null;
                if (result.data) {
                    if (Array.isArray(result.data)) dataItem = result.data[0];
                    else dataItem = result.data;
                }
                const msg = (result.msg || result.message || '').toLowerCase();
                const statusText = dataItem ? (dataItem.status_text || '') : '';
                const isExplicitSuccess = (statusText === 'SUKSES'); 
                
                if (result.ok === true && isExplicitSuccess) {
                    isSuccess = true;
                    trxIdProvider = dataItem.kode || dataItem.trxid || '-';
                    finalSN = dataItem.sn || '-';
                    if (dataItem.kode_produk === 'CFMX' || (finalSN && finalSN.toLowerCase().includes('varian'))) {
                         finalMessage = `${finalSN}. Tujuan: ${dataItem.tujuan || tujuan}`;
                    } else {
                        finalMessage = `${statusText}. SN: ${finalSN}`;
                    }
                } else {
                    if (result.ok === false && (msg.includes('stok kosong') || msg.includes('#gagal'))) {
                        isStockEmpty = true;
                        const logMsg = result.msg || 'Stok Kosong';
                        detailedErrorLog = `[STOK KOSONG] ${logMsg}`;
                        finalMessage = logMsg;
                    } 
                    if (!isStockEmpty) {
                         if (dataItem) finalMessage = dataItem.keterangan || dataItem.status_text || 'Pending/Gagal';
                         else finalMessage = result.message || result.msg || 'Gagal/Maintenance';
                    }
                }
            }

            // --- DATABASE ACTION (PENYELESAIAN PESANAN) ---
            if (isSuccess) {
                console.log(`   ✅ SUKSES! Pesan: ${finalMessage}`);
                
                // ID Dokumen History
                const historyId = po.historyId || `TRX-${Date.now()}`;
                
                // 1. PINDAHKAN KE RIWAYAT TRANSAKSI (History)
                // Ini membuat pesanan muncul di menu riwayat user & panel admin
                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    // Data Standar
                    uid: uidUser, 
                    trx_id: reffId, 
                    trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    title: po.productName || skuProduk, 
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
                    
                    // --- REQ: DATA MENTAH UNTUK ADMIN PANEL ---
                    // Menyimpan seluruh objek result dari Relay menjadi string JSON
                    raw_provider_json: JSON.stringify(result), 
                    provider_source: serverType
                });

                // 2. KIRIM NOTIFIKASI
                await sendUserLog(uidUser, "Transaksi Berhasil", finalMessage, historyId);
                
                // 3. SELESAIKAN PESANAN DARI ANTRIAN (HILANG DARI PREORDER)
                // Karena data sudah aman tersimpan di 'history', data di 'preorders'
                // WAJIB dihapus agar tidak diproses ulang oleh worker di putaran berikutnya.
                console.log(`   🗑️ Pesanan Selesai. Menghapus dari antrian Preorder...`);
                await db.collection('preorders').doc(poID).delete();

            } else if (isStockEmpty) {
                console.log(`   ⚠️ GAGAL STOK KOSONG: ${detailedErrorLog}`);
                // Gagal stok kosong -> Tetap di antrian tapi diberi log
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] ${detailedErrorLog}`
                });

            } else {
                console.log(`   ⏳ PENDING/RETRY: ${finalMessage}`);
                // Gagal pending -> Tetap di antrian untuk dicoba lagi nanti
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] [RETRY] ${finalMessage}`
                });
            }

            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        process.exit(1);
    }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();