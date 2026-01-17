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

// --- 2. KONFIGURASI RELAY & TELEGRAM ---
const VERCEL_DOMAIN = "https://www.pandawa-digital.store"; 
const KHFY_KEY = process.env.KHFY_API_KEY; 
const ICS_KEY = process.env.ICS_API_KEY; 

// 🔥 KONFIGURASI TELEGRAM LOG 🔥
const TG_TOKEN = "7850521841:AAH84wtuxnDWg5u04lMkL5zqVcY1hIpzGJg";
const TG_CHAT_ID = "7348139166";

// Fungsi Kirim Log ke Telegram
async function sendTelegramLog(message, isUrgent = false) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID,
                text: message,
                parse_mode: 'HTML', 
                disable_notification: !isUrgent 
            })
        }).catch(err => console.log("TG Err:", err.message));
    } catch (e) {
        // Silent error
    }
}

// ============================================================
// 🛠️ FUNGSI CEK STOK (DIPANGGIL CUMA 1X DI AWAL)
// ============================================================

async function getKHFYStockList() {
    console.log("      📋 [PHASE 1] Mengunduh Database Stok KHFY...");
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
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/1.0' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);

        const json = await response.json();
        const stockMap = {};
        if (json && json.data && Array.isArray(json.data)) {
            json.data.forEach(item => {
                stockMap[item.kode_produk] = {
                    gangguan: item.gangguan == 1, kosong: item.kosong == 1, status: item.status
                };
            });
            return stockMap;
        }
        return null; 
    } catch (error) { return null; }
}

async function getICSStockList() {
    console.log("      📋 [PHASE 1] Mengunduh Database Stok ICS...");
    const params = new URLSearchParams();
    params.append('action', 'pricelist'); params.append('apikey', ICS_KEY);
    const targetUrl = `${VERCEL_DOMAIN}/api/relay?${params.toString()}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); 
        const response = await fetch(targetUrl, { 
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/1.0' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);
        const json = await response.json();
        const stockMap = {};
        if (json && json.data && Array.isArray(json.data)) {
            json.data.forEach(item => {
                const isGangguan = item.status === 'gangguan' || item.status === 'error';
                const isKosong = item.status === 'empty' || item.stock === 0 || item.status === 'kosong';
                const isNonAktif = item.status === 'nonactive';
                stockMap[item.code] = { gangguan: isGangguan, kosong: isKosong, nonaktif: isNonAktif };
            });
            return stockMap;
        }
        return null;
    } catch (error) { return null; }
}

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
        params.append('api_key', KHFY_KEY);
        if (isRecheck) params.append('endpoint', '/history');
        else params.append('endpoint', '/trx');
        params.append('produk', data.sku); 
        params.append('tujuan', data.tujuan); 
        params.append('reff_id', data.reffId);
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); 
        const response = await fetch(targetUrl, { 
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/1.0' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);
        const text = await response.text();
        try { return JSON.parse(text); } 
        catch (e) { return { status: false, message: "HTML Error", raw: text }; }
    } catch (error) { return { status: false, message: "Relay Timeout" }; }
}

async function sendUserLog(uid, title, message, trxId) {
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('notifications').add({
            title, message, type: 'transaksi', trxId, isRead: false,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { }
}

// ============================================================
// 🏁 LOGIKA UTAMA (WORKER)
// ============================================================
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER...`);

    try {
        const snapshot = await db.collection('preorders').orderBy('timestamp', 'asc').limit(100).get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian.");
            return;
        }
        
        // Cek Stok Sekali Saja
        const [stockMapKHFY, stockMapICS] = await Promise.all([getKHFYStockList(), getICSStockList()]);
        
        for (const doc of snapshot.docs) {
            const po = doc.data();
            const poID = doc.id;
            const uidUser = po.uid; 
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            const serverType = po.serverType || 'KHFY'; 

            console.log(`🔹 TRX: ${poID} | ${serverType} | ${skuProduk}`);

            // 1. Validasi
            if (!skuProduk || !tujuan) {
                await db.collection('preorders').doc(poID).delete(); 
                continue; 
            }

            // 2. CEK STOK (SILENT MODE)
            let isSkip = false;
            let skipReason = '';

            if (serverType === 'KHFY' && stockMapKHFY) {
                const info = stockMapKHFY[skuProduk];
                if (info) {
                    if (info.gangguan) { isSkip = true; skipReason = 'KHFY GANGGUAN'; }
                    else if (info.kosong) { isSkip = true; skipReason = 'KHFY STOK KOSONG'; }
                    else if (info.status === 0) { isSkip = true; skipReason = 'KHFY NONAKTIF'; }
                }
            } else if (serverType === 'ICS' && stockMapICS) {
                const info = stockMapICS[skuProduk];
                if (info) {
                    if (info.gangguan) { isSkip = true; skipReason = 'ICS GANGGUAN'; }
                    else if (info.kosong) { isSkip = true; skipReason = 'ICS STOK KOSONG'; }
                    else if (info.nonaktif) { isSkip = true; skipReason = 'ICS NONAKTIF'; }
                }
            }

            if (isSkip) {
                console.log(`   ⛔ SKIP: ${skipReason}`);
                await sendTelegramLog(`⛔ <b>SKIP TRX (Hemat Saldo)</b>\nAlasan: ${skipReason}\nProduk: ${skuProduk}\nTujuan: ${tujuan}`);
                continue; 
            }

            // 3. LOCK REFF ID
            let reffId = po.active_reff_id;
            if (!reffId) {
                reffId = `AUTO-${Date.now()}`; 
                await db.collection('preorders').doc(poID).update({ active_reff_id: reffId });
            }

            // 4. EKSEKUSI
            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            let result = await hitVercelRelay(serverType, requestData, false);

            let msgRaw = (result.msg || result.message || (result.data ? result.data.message : '')).toLowerCase();
            let isDuplicate = msgRaw.includes('sudah ada') || msgRaw.includes('sudah pernah') || msgRaw.includes('duplicate');

            if (serverType !== 'ICS' && !isDuplicate) {
                const isQueued = msgRaw.includes('proses') || msgRaw.includes('berhasil') || msgRaw.includes('pending');
                if (result.ok === true && isQueued) {
                    await new Promise(r => setTimeout(r, 5000));
                    isDuplicate = true; 
                }
            }

            if (isDuplicate) {
                const checkResult = await hitVercelRelay(serverType, requestData, true);
                if (checkResult && (checkResult.ok === true || checkResult.data)) {
                    result = checkResult; 
                }
            }
            
            // 5. ANALISA HASIL
            let isSuccess = false;
            let finalMessage = '-';
            let finalSN = '-';
            let trxIdProvider = '-';
            let isHardFail = false; 

            if (serverType === 'ICS') {
                if (result.success === true && result.data) {
                    if (result.data.status === 'success') {
                        isSuccess = true; finalMessage = result.data.message; finalSN = result.data.sn || '-'; trxIdProvider = result.data.refid || '-';
                    } else if (result.data.status === 'failed') {
                        isHardFail = true; finalMessage = result.data.message;
                    } else { finalMessage = result.data.message || 'Pending'; }
                } 
                if (!isSuccess && !isHardFail) finalMessage = result.message || 'Gagal/Pending ICS';

            } else {
                let dataItem = null;
                if (result.data) {
                    if (Array.isArray(result.data)) dataItem = result.data[0]; else dataItem = result.data;
                }
                const statusText = dataItem ? (dataItem.status_text || '') : '';
                const isExplicitSuccess = (statusText === 'SUKSES'); 
                
                if (result.ok === true && isExplicitSuccess) {
                    isSuccess = true; trxIdProvider = dataItem.kode || dataItem.trxid || '-'; finalSN = dataItem.sn || '-';
                    if (dataItem.kode_produk === 'CFMX' || (finalSN && finalSN.toLowerCase().includes('varian'))) {
                         finalMessage = `${finalSN}. Tujuan: ${dataItem.tujuan || tujuan}`;
                    } else { finalMessage = `${statusText}. SN: ${finalSN}`; }
                } else {
                    const msg = (result.msg || result.message || '').toLowerCase();
                    if (msg.includes('stok kosong') || msg.includes('#gagal')) {
                        isHardFail = true; finalMessage = msg;
                    } else if (dataItem && dataItem.status_text === 'GAGAL') {
                        isHardFail = true; finalMessage = dataItem.keterangan || 'Transaksi Gagal';
                    } else {
                        if (dataItem) finalMessage = dataItem.keterangan || dataItem.status_text || 'Pending';
                        else finalMessage = result.message || 'Pending/Maintenance';
                    }
                }
            }

            // --- FILTER JSON UNTUK TELEGRAM (Agar Tidak Ganda) ---
            let dataLog = result;
            if (result.data && Array.isArray(result.data)) {
                // Jika data berupa Array (Banyak History), ambil index 0 (Terbaru)
                dataLog = { 
                    ...result, 
                    data: result.data[0], 
                    note: "Data difilter (Ambil yg terbaru saja)"
                };
            }
            const rawJsonStr = JSON.stringify(dataLog, null, 2); 
            const rawLogBlock = `\n<pre><code class="json">${rawJsonStr.substring(0, 3000)}</code></pre>`;


            // 6. KEPUTUSAN & LOGGING
            if (isSuccess) {
                console.log(`   ✅ SUKSES!`);
                const historyId = po.historyId || `TRX-${Date.now()}`;
                let finalTitle = po.productName || skuProduk;
                if (!finalTitle.toLowerCase().includes('preorder')) finalTitle = `[PreOrder] ${finalTitle}`;

                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser, trx_id: reffId, trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    title: finalTitle, type: 'out', amount: po.price || 0, status: 'Sukses',
                    dest_num: tujuan, sn: finalSN, trx_id_provider: trxIdProvider, provider_code: skuProduk,
                    date: new Date().toISOString(), api_msg: finalMessage, balance_before: 0, balance_after: 0,
                    is_preorder: true, raw_provider_json: JSON.stringify(result), provider_source: serverType
                });

                await sendUserLog(uidUser, "PreOrder Berhasil", `Sukses: ${finalTitle}`, historyId);
                
                // NOTIF TELEGRAM + RAW JSON
                await sendTelegramLog(`✅ <b>SUKSES!</b>\nProduk: ${finalTitle}\nSN: ${finalSN}\nTujuan: ${tujuan}${rawLogBlock}`, true);
                
                await db.collection('preorders').doc(poID).delete();

            } else {
                if (isHardFail) {
                     console.log(`   ⚠️ HARD FAIL: ${finalMessage}. Reset ID.`);
                     // LOG HARD FAIL + RAW JSON
                     await sendTelegramLog(`⚠️ <b>HARD FAIL (Reset ID)</b>\nPesan: ${finalMessage}\nProduk: ${skuProduk}\nTujuan: ${tujuan}${rawLogBlock}`);
                     
                     await db.collection('preorders').doc(poID).update({
                        active_reff_id: admin.firestore.FieldValue.delete(), 
                        debugLogs: `[${new Date().toLocaleTimeString()}] [FAIL-RESET] ${finalMessage}`
                    });
                } else {
                    console.log(`   ⏳ PENDING/SOFT FAIL.`);
                    // LOG PENDING + RAW JSON
                    await sendTelegramLog(`⏳ <b>PENDING/RETRY</b>\nPesan: ${finalMessage}\nProduk: ${skuProduk}${rawLogBlock}`);
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) { console.error("CRITICAL ERROR:", error); process.exit(1); }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();