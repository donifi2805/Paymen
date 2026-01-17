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

// 🔥 KONFIGURASI TELEGRAM 🔥
const TG_TOKEN = "7850521841:AAH84wtuxnDWg5u04lMkL5zqVcY1hIpzGJg";
const TG_CHAT_ID = "7348139166";

// Helper: Get Jam WIB
function getWIBTime() {
    return new Date().toLocaleTimeString('id-ID', { 
        timeZone: 'Asia/Jakarta', 
        hour12: false,
        hour: '2-digit', minute: '2-digit', second: '2-digit'
    }).replace(/\./g, ':');
}

// Helper: Sanitasi HTML
function escapeHtml(text) {
    if (!text) return text;
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

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
    } catch (e) { }
}

// ============================================================
// 🛠️ FUNGSI CEK STOK (PHASE 1)
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
                stockMap[item.code] = { 
                    gangguan: isGangguan, kosong: isKosong, nonaktif: isNonAktif
                };
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
        
        await sendTelegramLog("================================");

        const [stockMapKHFY, stockMapICS] = await Promise.all([getKHFYStockList(), getICSStockList()]);
        let skippedTransactions = [];

        for (const doc of snapshot.docs) {
            const po = doc.data();
            const poID = doc.id;
            const uidUser = po.uid; 
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            const serverType = po.serverType || 'KHFY'; 

            // AMBIL USERNAME
            let buyerName = po.username || 'User'; 
            if (uidUser) {
                try {
                    const userSnap = await db.collection('users').doc(uidUser).get();
                    if (userSnap.exists) {
                        const userData = userSnap.data();
                        buyerName = userData.username || userData.name || userData.email || 'Tanpa Nama';
                    }
                } catch (e) {}
            }
            
            console.log(`🔹 TRX: ${poID} | ${buyerName} | ${serverType} | ${skuProduk}`);

            if (!skuProduk || !tujuan) {
                await db.collection('preorders').doc(poID).delete(); 
                continue; 
            }

            // CEK STOK (SILENT)
            let isSkip = false;
            let skipReason = '';

            if (serverType === 'KHFY' && stockMapKHFY) {
                const info = stockMapKHFY[skuProduk];
                if (info) {
                    if (info.gangguan) { isSkip = true; skipReason = 'GANGGUAN'; }
                    else if (info.kosong) { isSkip = true; skipReason = 'STOK KOSONG'; }
                    else if (info.status === 0) { isSkip = true; skipReason = 'NONAKTIF'; }
                }
            } else if (serverType === 'ICS' && stockMapICS) {
                const info = stockMapICS[skuProduk];
                if (info) {
                    if (info.gangguan) { isSkip = true; skipReason = 'GANGGUAN'; }
                    else if (info.kosong) { isSkip = true; skipReason = 'STOK KOSONG'; }
                    else if (info.nonaktif) { isSkip = true; skipReason = 'NONAKTIF'; }
                }
            }

            if (isSkip) {
                console.log(`   ⛔ SKIP: ${skipReason}`);
                // Masukkan data lengkap untuk log
                skippedTransactions.push({
                    buyer: buyerName, 
                    sku: skuProduk, 
                    dest: tujuan, 
                    reason: skipReason,
                    server: serverType
                });
                continue; 
            }

            // PROSES TRANSAKSI
            let reffId = po.active_reff_id;
            if (!reffId) {
                reffId = `AUTO-${Date.now()}`; 
                await db.collection('preorders').doc(poID).update({ active_reff_id: reffId });
            }

            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            let result = await hitVercelRelay(serverType, requestData, false);

            const isExplicitPending = result.success === true && result.data && result.data.status === 'pending';
            if (isExplicitPending) {
                console.log(`      ⏳ Respon Pending Spesifik. Menunggu 6 detik...`);
                await new Promise(r => setTimeout(r, 6000));
                console.log(`      🔄 Recheck Status...`);
                const checkResult = await hitVercelRelay(serverType, requestData, true);
                if (checkResult) { result = checkResult; }
            }

            let msgRaw = String(
                result.msg || result.message || (result.data && result.data.message) || ''
            ).toLowerCase();
            
            let isDuplicate = msgRaw.includes('sudah ada') || msgRaw.includes('sudah pernah') || msgRaw.includes('duplicate');

            if (serverType !== 'ICS' && !isDuplicate) {
                const isQueued = msgRaw.includes('proses') || msgRaw.includes('berhasil') || msgRaw.includes('pending');
                if (result.ok === true && isQueued) {
                    if(!isExplicitPending) await new Promise(r => setTimeout(r, 5000)); 
                    isDuplicate = true; 
                }
            }

            if (isDuplicate) {
                const checkResult = await hitVercelRelay(serverType, requestData, true);
                if (checkResult && (checkResult.ok === true || checkResult.data)) { result = checkResult; }
            }
            
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

            // FILTER JSON CERDAS
            let dataLog = result;
            if (result.data && Array.isArray(result.data) && result.data.length > 0) {
                const firstItem = result.data[0];
                const refDate = (firstItem.tgl_entri || firstItem.tgl_status || firstItem.date || new Date().toISOString()).substring(0, 10);
                const filteredData = result.data.filter((item, index) => {
                    if (index === 0) return true; 
                    const tgl = item.tgl_entri || item.tgl_status || item.date || '';
                    const status = (item.status_text || item.status || '').toUpperCase();
                    const isSameDay = tgl.includes(refDate);
                    const isSuccess = status.includes('SUKSES') || status === 'SUCCESS';
                    return isSuccess && isSameDay;
                });
                dataLog = { ...result, data: filteredData, note: `Filter: Terbaru + Sukses Tgl ${refDate}` };
            }

            // --- BUILD MESSAGE (DENGAN EXPANDABLE BLOCKQUOTE) ---
            const rawJsonStr = JSON.stringify(dataLog, null, 2); 
            const safeJsonStr = escapeHtml(rawJsonStr.substring(0, 3500));
            const jsonBlock = `\n<b>🔽 JSON RESPONSE:</b>\n<blockquote expandable><pre><code class="json">${safeJsonStr}</code></pre></blockquote>`;

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
                
                const logMsg = `<b>LOG (${getWIBTime()})</b>\n` +
                               `✅ <b>STATUS: SUKSES</b>\n` +
                               `---------------------------\n` +
                               `👤 <b>Pembeli:</b> ${buyerName}\n` +
                               `📦 <b>Produk:</b> ${finalTitle}\n` +
                               `📱 <b>Tujuan:</b> ${tujuan}\n` +
                               `🧾 <b>SN:</b> ${finalSN}\n` +
                               jsonBlock;

                await sendTelegramLog(logMsg, true);
                await db.collection('preorders').doc(poID).delete();

            } else {
                if (isHardFail) {
                     console.log(`   ⚠️ HARD FAIL: ${finalMessage}. Reset ID.`);
                     const logMsg = `<b>LOG (${getWIBTime()})</b>\n` +
                                    `⚠️ <b>STATUS: HARD FAIL (RESET ID)</b>\n` +
                                    `---------------------------\n` +
                                    `👤 <b>Pembeli:</b> ${buyerName}\n` +
                                    `📦 <b>Produk:</b> ${skuProduk}\n` +
                                    `📱 <b>Tujuan:</b> ${tujuan}\n` +
                                    `💬 <b>Pesan:</b> ${finalMessage}\n` +
                                    jsonBlock;

                     await sendTelegramLog(logMsg);
                     await db.collection('preorders').doc(poID).update({
                        active_reff_id: admin.firestore.FieldValue.delete(), 
                        debugLogs: `[${new Date().toLocaleTimeString()}] [FAIL-RESET] ${finalMessage}`
                    });
                } else {
                    console.log(`   ⏳ PENDING/SOFT FAIL.`);
                    const logMsg = `<b>LOG (${getWIBTime()})</b>\n` +
                                   `⏳ <b>STATUS: PENDING/RETRY</b>\n` +
                                   `---------------------------\n` +
                                   `👤 <b>Pembeli:</b> ${buyerName}\n` +
                                   `📦 <b>Produk:</b> ${skuProduk}\n` +
                                   `💬 <b>Pesan:</b> ${finalMessage}\n` +
                                   jsonBlock;
                    await sendTelegramLog(logMsg);
                }
            }
            await new Promise(r => setTimeout(r, 2000));
        }

        // --- 🔥 KIRIM REKAP SKIP (FORMAT BARU RAPIH) 🔥 ---
        if (skippedTransactions.length > 0) {
            let skipMsg = `<b>LOG (${getWIBTime()})</b>\n`;
            skipMsg += `⏳ <b>DAFTAR ANTREAN STOK KOSONG</b>\n`; // Judul Baru
            
            // Loop data skip dengan format card
            skippedTransactions.forEach((item) => {
                skipMsg += `➖➖➖➖➖➖➖➖➖➖\n`; // Garis putus-putus
                skipMsg += `<b>${item.buyer}</b>\n`; // Nama Pembeli (Bold)
                skipMsg += `${item.dest} | ${item.sku}\n`; // Nomor | Produk
                skipMsg += `⚠️ ${item.reason} (Menunggu Role)\n`; // Alasan
                skipMsg += `📡 Server: ${item.server}\n`; // Server
            });

            skipMsg += `➖➖➖➖➖➖➖➖➖➖\n`;
            skipMsg += `<i>Total: ${skippedTransactions.length} Antrean ditunda.</i>`;
            
            // Kirim 1 pesan rekap
            await sendTelegramLog(skipMsg);
        }

        await sendTelegramLog("================================");

    } catch (error) { console.error("CRITICAL ERROR:", error); process.exit(1); }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();