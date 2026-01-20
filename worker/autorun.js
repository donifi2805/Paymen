const admin = require('firebase-admin');

// --- 1. SETUP FIREBASE ---
try {
    // Pastikan variabel lingkungan ini tetap ada di sistem Anda atau GitHub Secrets
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

// --- 2. KONFIGURASI PROVIDER LANGSUNG (BYPASS VERCEL) ---
const KHFY_BASE_URL = "https://panel.khfy-store.com/api_v2";
const ICS_BASE_URL = "https://api.ics-store.my.id/api/reseller";

// ⚠️ HARDCODED API KEYS (HANYA UNTUK DEV LOKAL - JANGAN PUSH KE GITHUB PUBLIC) ⚠️
const KHFY_KEY = "8F1199C1-483A-4C96-825E-F5EBD33AC60A"; 
const ICS_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77"; 

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
// 🛠️ FUNGSI CEK STOK LANGSUNG (PHASE 1)
// ============================================================

async function getKHFYStockList() {
    console.log("      📋 [PHASE 1] Direct Check Stok KHFY...");
    const params = new URLSearchParams();
    params.append('api_key', KHFY_KEY);
    // KHFY endpoint
    const targetUrl = `${KHFY_BASE_URL}/list_product?${params.toString()}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); 
        const response = await fetch(targetUrl, { 
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/Direct' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);

        const json = await response.json();
        const stockMap = {};
        
        let dataList = [];
        if (json && json.data && Array.isArray(json.data)) dataList = json.data;
        else if (json && Array.isArray(json)) dataList = json;

        if (dataList.length > 0) {
            dataList.forEach(item => {
                stockMap[item.kode_produk] = {
                    gangguan: item.gangguan == 1, 
                    kosong: item.kosong == 1, 
                    status: item.status,
                    source: 'KHFY'
                };
            });
            return stockMap;
        }
        return null; 
    } catch (error) { 
        console.error("KHFY Stock Err:", error.message);
        return null; 
    }
}

async function getICSStockList() {
    console.log("      📋 [PHASE 1] Direct Check Stok ICS...");
    const params = new URLSearchParams();
    params.append('apikey', ICS_KEY);
    // ICS endpoint
    const targetUrl = `${ICS_BASE_URL}/products?${params.toString()}`;

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); 
        const response = await fetch(targetUrl, { 
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/Direct' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);
        const json = await response.json();
        const stockMap = {};
        
        let dataList = [];
        if (json && json.ready && Array.isArray(json.ready)) dataList = json.ready; 
        else if (json && json.data && Array.isArray(json.data)) dataList = json.data; 

        if (dataList.length > 0) {
            dataList.forEach(item => {
                const isGangguan = item.status === 'gangguan' || item.status === 'error';
                const isKosong = item.status === 'empty' || item.stock === 0 || item.status === 'kosong';
                const isNonAktif = item.status === 'nonactive';
                
                stockMap[item.code] = { 
                    gangguan: isGangguan, 
                    kosong: isKosong, 
                    nonaktif: isNonAktif,
                    source: 'ICS'
                };
            });
            return stockMap;
        }
        return null;
    } catch (error) { 
        console.error("ICS Stock Err:", error.message);
        return null; 
    }
}

// 🔥 FUNGSI HIT PROVIDER LANGSUNG (BYPASS VERCEL) 🔥
async function hitProviderDirect(serverType, data, isRecheck = false) {
    let targetUrl = '';
    let method = 'GET';
    let body = null;
    let headers = { 'User-Agent': 'Pandawa-Worker/Direct', 'Accept': 'application/json' };

    // --- LOGIKA ICS (DIRECT) ---
    if (serverType === 'ICS') {
        if (isRecheck) {
            // Cek Status: GET /trx/{REFID}
            targetUrl = `${ICS_BASE_URL}/trx/${data.reffId}?apikey=${ICS_KEY}`;
            method = 'GET';
        } else {
            // Transaksi Baru: POST /trx
            targetUrl = `${ICS_BASE_URL}/trx?apikey=${ICS_KEY}`;
            method = 'POST';
            headers['Content-Type'] = 'application/json';
            
            body = JSON.stringify({
                product_code: data.sku,
                dest_number: data.tujuan,
                ref_id_custom: data.reffId
            });
        }
    } 
    // --- LOGIKA KHFY (DIRECT) ---
    else {
        const params = new URLSearchParams();
        params.append('api_key', KHFY_KEY);
        
        if (isRecheck) {
            // Cek Status: /history
            targetUrl = `${KHFY_BASE_URL}/history?api_key=${KHFY_KEY}&refid=${data.reffId}`;
        } else {
            // Transaksi Baru: /trx
            params.append('produk', data.sku); 
            params.append('tujuan', data.tujuan); 
            params.append('reff_id', data.reffId);
            targetUrl = `${KHFY_BASE_URL}/trx?${params.toString()}`;
        }
        method = 'GET'; 
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); 
        
        const fetchOptions = { 
            method: method, 
            headers: headers, 
            signal: controller.signal 
        };

        if (body) {
            fetchOptions.body = body;
        }

        const response = await fetch(targetUrl, fetchOptions);
        clearTimeout(timeoutId);
        
        const text = await response.text();
        
        // Handle HTML Error
        if (text.trim().startsWith('<')) {
             return { status: false, message: "HTML Error (Mungkin Maintenance)", raw: text.substring(0, 100) };
        }

        try { return JSON.parse(text); } 
        catch (e) { return { status: false, message: "Invalid JSON", raw: text }; }

    } catch (error) { return { status: false, message: "Connection Timeout: " + error.message }; }
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
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER (DIRECT MODE - LOCAL DEV)...`);

    try {
        const snapshot = await db.collection('preorders').orderBy('timestamp', 'asc').limit(100).get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian.");
            return;
        }
        
        await sendTelegramLog("================================");

        const [stockMapKHFY, stockMapICS] = await Promise.all([getKHFYStockList(), getICSStockList()]);
        
        let skippedTransactions = [];
        let successCount = 0;

        for (const doc of snapshot.docs) {
            const po = doc.data();
            const poID = doc.id;
            const uidUser = po.uid; 
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            
            let serverType = po.serverType;
            if (!serverType) {
                const provCode = (po.provider || "").toUpperCase();
                if (provCode.startsWith('ICS')) { serverType = 'ICS'; } 
                else { serverType = 'KHFY'; }
            }

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
                skippedTransactions.push({
                    buyer: buyerName, sku: skuProduk, dest: tujuan, reason: skipReason, server: serverType 
                });
                continue; 
            }

            let reffId = po.active_reff_id;
            if (!reffId) {
                reffId = `${serverType}-AUTO-${Date.now()}`; 
                await db.collection('preorders').doc(poID).update({ active_reff_id: reffId });
            }

            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            
            // 🔥 HIT PROVIDER LANGSUNG 🔥
            let result = await hitProviderDirect(serverType, requestData, false);

            const isExplicitPending = result.success === true && result.data && result.data.status === 'pending';
            if (isExplicitPending) {
                console.log(`      ⏳ Respon Pending Spesifik. Menunggu 6 detik...`);
                await new Promise(r => setTimeout(r, 6000));
                
                console.log(`      🔄 Recheck Status...`);
                const checkResult = await hitProviderDirect(serverType, requestData, true);
                if (checkResult) { result = checkResult; }
            }

            let msgRaw = String(
                result.msg || result.message || (result.data && result.data.message) || ''
            ).toLowerCase();
            
            let isDuplicate = msgRaw.includes('sudah ada') || msgRaw.includes('sudah pernah') || msgRaw.includes('duplicate') || msgRaw.includes('sdh pernah');

            if (serverType !== 'ICS' && !isDuplicate) {
                const isQueued = msgRaw.includes('proses') || msgRaw.includes('berhasil') || msgRaw.includes('pending');
                if (result.ok === true && isQueued) {
                    if(!isExplicitPending) await new Promise(r => setTimeout(r, 5000)); 
                    isDuplicate = true; 
                }
            }

            if (isDuplicate) {
                const checkResult = await hitProviderDirect(serverType, requestData, true);
                if (checkResult && (checkResult.ok === true || checkResult.data)) { result = checkResult; }
            }
            
            let isSuccess = false;
            let finalMessage = '-';
            let finalSN = '-';
            let trxIdProvider = '-';
            let isHardFail = false; 

            // ANALISA HASIL
            if (serverType === 'ICS') {
                if (result.success === true && result.data) {
                    if (result.data.status === 'success' || result.data.status === 'sukses') {
                        isSuccess = true; finalMessage = result.data.message; finalSN = result.data.sn || '-'; trxIdProvider = result.data.refid || '-';
                    } else if (result.data.status === 'failed' || result.data.status === 'gagal') {
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

            // FILTER JSON
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

            const rawJsonStr = JSON.stringify(dataLog, null, 2); 
            const safeJsonStr = escapeHtml(rawJsonStr.substring(0, 3500));
            const jsonBlock = `\n<b>🔽 JSON RESPONSE (${serverType}):</b>\n<blockquote expandable><pre><code class="json">${safeJsonStr}</code></pre></blockquote>`;

            if (isSuccess) {
                console.log(`   ✅ SUKSES!`);
                successCount++; 

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
            await new Promise(r => setTimeout(r, 6000));
        }

        if (skippedTransactions.length > 0 || successCount > 0) {
            let rekapMsg = `<b>LOG (${getWIBTime()})</b>\n`;
            if (skippedTransactions.length > 0) {
                rekapMsg += `⏳ <b>DAFTAR ANTREAN STOK KOSONG</b>\n`;
                skippedTransactions.forEach((item) => {
                    rekapMsg += `➖➖➖➖➖➖➖➖➖➖\n`;
                    rekapMsg += `<b>${item.buyer}</b>\n`;
                    rekapMsg += `${item.dest} | ${item.sku}\n`;
                    rekapMsg += `⚠️ ${item.reason} (Menunggu Role)\n`;
                    rekapMsg += `📡 Server: ${item.server}\n`; 
                });
                rekapMsg += `➖➖➖➖➖➖➖➖➖➖\n`;
            } else {
                rekapMsg += `✅ <b>REKAP SESI</b>\n`;
                rekapMsg += `---------------------------\n`;
            }
            rekapMsg += `<i>Total: ${skippedTransactions.length} Antrean ditunda.</i>\n`;
            rekapMsg += `<i>Total: ${successCount} Antrean berhasil.</i>`;
            await sendTelegramLog(rekapMsg);
        }
        await sendTelegramLog("================================");
    } catch (error) { console.error("CRITICAL ERROR:", error); process.exit(1); }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();