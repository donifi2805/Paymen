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
const KHFY_BASE_URL = "https://panel.khfy-store.com/api_v2";
const KHFY_AKRAB_URL = "https://panel.khfy-store.com/api_v3/cek_stock_akrab"; // 🔥 URL V3 KHUSUS
const ICS_BASE_URL = "https://api.ics-store.my.id/api/reseller";

// ⚠️ API KEYS (HARDCODED UNTUK DEVELOPMENT LOKAL)
const KHFY_KEY = "8F1199C1-483A-4C96-825E-F5EBD33AC60A"; 
const ICS_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77"; 

// 🔥 KONFIGURASI TELEGRAM 🔥
const TG_TOKEN = "7850521841:AAH84wtuxnDWg5u04lMkL5zqVcY1hIpzGJg";
const TG_CHAT_ID = "7348139166";

// DAFTAR PRODUK SPESIAL KHFY (WAJIB CEK SLOT V3)
const KHFY_SPECIAL_CODES = ['XLA14', 'XLA32', 'XLA39', 'XLA51', 'XLA65', 'XLA89'];

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
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function sendTelegramLog(message, isUrgent = false) {
    if (!TG_TOKEN || !TG_CHAT_ID) return;
    try {
        const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: TG_CHAT_ID, text: message, parse_mode: 'HTML', disable_notification: !isUrgent 
            })
        }).catch(err => {});
    } catch (e) { }
}

// ============================================================
// 🛠️ FUNGSI CEK STOK & SLOT
// ============================================================

// 1. Cek Stok Biasa (KHFY API V2)
async function getKHFYStockList() {
    // console.log("      📋 [PHASE 1] Cek Stok KHFY Regular...");
    const params = new URLSearchParams();
    params.append('api_key', KHFY_KEY);
    const targetUrl = `${KHFY_BASE_URL}/list_product?${params.toString()}`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); 
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
                    gangguan: item.gangguan == 1, kosong: item.kosong == 1, status: item.status
                };
            });
            return stockMap;
        }
        return null; 
    } catch (error) { return null; }
}

// 2. 🔥 BARU: Cek Slot Akrab (KHFY API V3) 🔥
async function getKHFYAkrabSlots() {
    console.log("      📋 [PHASE 0] Cek Slot Akrab KHFY (V3)...");
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); 
        const response = await fetch(KHFY_AKRAB_URL, { 
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/Direct' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);
        
        const json = await response.json();
        const slotMap = {}; // Format: { 'XLA14': 1, 'XLA32': 0 }

        if (json && json.ok === true && Array.isArray(json.data)) {
            json.data.forEach(item => {
                // Mapping item.type (XLA14) ke item.sisa_slot
                slotMap[item.type] = parseInt(item.sisa_slot || 0);
            });
            // console.log("      ✅ Slot Map:", JSON.stringify(slotMap));
            return slotMap;
        }
        return null;
    } catch (error) {
        console.error("Gagal Cek Slot V3:", error.message);
        return null;
    }
}

// 3. Cek Stok ICS
async function getICSStockList() {
    // console.log("      📋 [PHASE 1] Cek Stok ICS...");
    const params = new URLSearchParams();
    params.append('apikey', ICS_KEY);
    const targetUrl = `${ICS_BASE_URL}/products?${params.toString()}`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); 
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
                stockMap[item.code] = { 
                    gangguan: item.status === 'gangguan' || item.status === 'error', 
                    kosong: item.status === 'empty' || item.stock === 0 || item.status === 'kosong', 
                    nonaktif: item.status === 'nonactive'
                };
            });
            return stockMap;
        }
        return null;
    } catch (error) { return null; }
}

// 🔥 FUNGSI HIT PROVIDER LANGSUNG 🔥
async function hitProviderDirect(serverType, data, isRecheck = false) {
    let targetUrl = '';
    let method = 'GET';
    let body = null;
    let headers = { 'User-Agent': 'Pandawa-Worker/Direct', 'Accept': 'application/json' };

    if (serverType === 'ICS') {
        if (isRecheck) {
            targetUrl = `${ICS_BASE_URL}/trx/${data.reffId}?apikey=${ICS_KEY}`;
        } else {
            targetUrl = `${ICS_BASE_URL}/trx?apikey=${ICS_KEY}`;
            method = 'POST';
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify({ product_code: data.sku, dest_number: data.tujuan, ref_id_custom: data.reffId });
        }
    } else {
        const params = new URLSearchParams();
        params.append('api_key', KHFY_KEY);
        if (isRecheck) {
            targetUrl = `${KHFY_BASE_URL}/history?api_key=${KHFY_KEY}&refid=${data.reffId}`;
        } else {
            params.append('produk', data.sku); params.append('tujuan', data.tujuan); params.append('reff_id', data.reffId);
            targetUrl = `${KHFY_BASE_URL}/trx?${params.toString()}`;
        }
    }

    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60000); 
        const fetchOptions = { method: method, headers: headers, signal: controller.signal };
        if (body) fetchOptions.body = body;

        const response = await fetch(targetUrl, fetchOptions);
        clearTimeout(timeoutId);
        const text = await response.text();
        if (text.trim().startsWith('<')) return { status: false, message: "HTML Error", raw: text.substring(0, 100) };
        try { return JSON.parse(text); } catch (e) { return { status: false, message: "Invalid JSON", raw: text }; }
    } catch (error) { return { status: false, message: "Timeout: " + error.message }; }
}

async function sendUserLog(uid, title, message, trxId) {
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('notifications').add({
            title, message, type: 'transaksi', trxId, isRead: false, timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
    } catch (e) { }
}

// ============================================================
// 🏁 LOGIKA UTAMA (WORKER)
// ============================================================
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER (KHFY SPECIAL MODE)...`);

    try {
        const snapshot = await db.collection('preorders').orderBy('timestamp', 'asc').limit(100).get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian.");
            return;
        }
        
        await sendTelegramLog("================================");

        // 🔥 AMBIL DATA STOK DARI SEMUA SUMBER (TERMASUK V3 KHUSUS) 🔥
        const [stockMapKHFY, stockMapICS, akrabSlotMap] = await Promise.all([
            getKHFYStockList(), 
            getICSStockList(),
            getKHFYAkrabSlots()
        ]);
        
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
                if (provCode.startsWith('ICS')) { serverType = 'ICS'; } else { serverType = 'KHFY'; }
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
            
            console.log(`🔹 TRX: ${poID} | ${serverType} | ${skuProduk} | ${buyerName}`);

            if (!skuProduk || !tujuan) { await db.collection('preorders').doc(poID).delete(); continue; }

            // ===============================================
            // 🛑 LOGIKA CEK STOK & SLOT (MODIFIKASI) 🛑
            // ===============================================
            let isSkip = false;
            let skipReason = '';

            // 1. CEK KHUSUS KHFY PRODUK SPESIAL (XLA14, dll)
            if (serverType === 'KHFY' && KHFY_SPECIAL_CODES.includes(skuProduk)) {
                if (akrabSlotMap) {
                    const sisaSlot = akrabSlotMap[skuProduk];
                    // Jika tidak ada di map, anggap 0
                    const currentSlot = (sisaSlot !== undefined) ? sisaSlot : 0;
                    
                    // SYARAT: HARUS LEBIH DARI 3 (Berarti 4, 5, dst jalan. 3, 2, 1, 0 skip)
                    if (currentSlot <= 3) {
                        isSkip = true;
                        skipReason = `SLOT TERBATAS (${currentSlot} <= 3)`;
                    } else {
                        console.log(`      ✅ Slot Aman: ${skuProduk} (Sisa: ${currentSlot})`);
                    }
                } else {
                    // Jika gagal ambil data V3, safety first: SKIP
                    isSkip = true;
                    skipReason = `GAGAL CEK SLOT V3`;
                }
            } 
            
            // 2. CEK STOK REGULAR (JIKA BELUM DI-SKIP OLEH LOGIKA SLOT)
            if (!isSkip) {
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
            }

            // EKSEKUSI SKIP
            if (isSkip) {
                console.log(`   ⛔ SKIP: ${skipReason}`);
                skippedTransactions.push({ buyer: buyerName, sku: skuProduk, dest: tujuan, reason: skipReason, server: serverType });
                continue; 
            }

            // ===============================================
            // 🚀 EKSEKUSI TRANSAKSI (SAMA SEPERTI BIASA)
            // ===============================================
            let reffId = po.active_reff_id;
            if (!reffId) {
                reffId = `${serverType}-AUTO-${Date.now()}`; 
                await db.collection('preorders').doc(poID).update({ active_reff_id: reffId });
            }

            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            let result = await hitProviderDirect(serverType, requestData, false);

            const isExplicitPending = result.success === true && result.data && result.data.status === 'pending';
            if (isExplicitPending) {
                console.log(`      ⏳ Pending Spesifik. Tunggu 6s...`);
                await new Promise(r => setTimeout(r, 6000));
                result = await hitProviderDirect(serverType, requestData, true) || result;
            }

            let msgRaw = String(result.msg || result.message || (result.data && result.data.message) || '').toLowerCase();
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

            const rawJsonStr = JSON.stringify(result, null, 2); 
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
                
                const logMsg = `<b>LOG (${getWIBTime()})</b>\n✅ <b>STATUS: SUKSES</b>\n---------------------------\n👤 <b>Pembeli:</b> ${buyerName}\n📦 <b>Produk:</b> ${finalTitle}\n📱 <b>Tujuan:</b> ${tujuan}\n🧾 <b>SN:</b> ${finalSN}\n${jsonBlock}`;
                await sendTelegramLog(logMsg, true);
                await db.collection('preorders').doc(poID).delete();

            } else {
                if (isHardFail) {
                     console.log(`   ⚠️ HARD FAIL: ${finalMessage}`);
                     const logMsg = `<b>LOG (${getWIBTime()})</b>\n⚠️ <b>STATUS: HARD FAIL (RESET ID)</b>\n---------------------------\n👤 <b>Pembeli:</b> ${buyerName}\n📦 <b>Produk:</b> ${skuProduk}\n💬 <b>Pesan:</b> ${finalMessage}\n${jsonBlock}`;
                     await sendTelegramLog(logMsg);
                     await db.collection('preorders').doc(poID).update({
                        active_reff_id: admin.firestore.FieldValue.delete(), 
                        debugLogs: `[${new Date().toLocaleTimeString()}] [FAIL-RESET] ${finalMessage}`
                    });
                } else {
                    console.log(`   ⏳ PENDING/SOFT FAIL.`);
                    const logMsg = `<b>LOG (${getWIBTime()})</b>\n⏳ <b>STATUS: PENDING/RETRY</b>\n---------------------------\n👤 <b>Pembeli:</b> ${buyerName}\n📦 <b>Produk:</b> ${skuProduk}\n💬 <b>Pesan:</b> ${finalMessage}\n${jsonBlock}`;
                    await sendTelegramLog(logMsg);
                }
            }
            await new Promise(r => setTimeout(r, 6000));
        }

        if (skippedTransactions.length > 0 || successCount > 0) {
            let rekapMsg = `<b>LOG (${getWIBTime()})</b>\n`;
            if (skippedTransactions.length > 0) {
                rekapMsg += `⏳ <b>DAFTAR ANTREAN DITUNDA</b>\n`;
                skippedTransactions.forEach((item) => {
                    rekapMsg += `➖➖➖➖➖➖➖➖➖➖\n<b>${item.buyer}</b>\n${item.dest} | ${item.sku}\n⚠️ ${item.reason}\n`; 
                });
            } else {
                rekapMsg += `✅ <b>REKAP SESI</b>\n---------------------------\n`;
            }
            rekapMsg += `<i>Total: ${skippedTransactions.length} Tunda | ${successCount} Sukses.</i>`;
            await sendTelegramLog(rekapMsg);
        }
        await sendTelegramLog("================================");
    } catch (error) { console.error("CRITICAL ERROR:", error); process.exit(1); }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();