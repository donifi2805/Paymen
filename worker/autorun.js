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
const KHFY_AKRAB_URL = "https://panel.khfy-store.com/api_v3/cek_stock_akrab";
const ICS_BASE_URL = "https://api.ics-store.my.id/api/reseller";

// ⚠️ API KEYS (PASTIKAN BENAR)
const KHFY_KEY = "8F1199C1-483A-4C96-825E-F5EBD33AC60A"; 
const ICS_KEY = "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77"; 

// 🔥 KONFIGURASI TELEGRAM 🔥
const TG_TOKEN = "7850521841:AAH84wtuxnDWg5u04lMkL5zqVcY1hIpzGJg";
const TG_CHAT_ID = "7348139166";

// DAFTAR SLOT V3
const KHFY_SPECIAL_CODES = ['XLA14', 'XLA32', 'XLA39', 'XLA51', 'XLA65', 'XLA89'];
const PRODUCT_NAMES = {
    'XLA14': 'Super Mini', 'XLA32': 'Mini', 'XLA39': 'Big',
    'XLA51': 'Jumbo V2', 'XLA65': 'Jumbo', 'XLA89': 'Mega Big'
};

// Helper: Get Jam WIB
function getWIBTime() {
    return new Date().toLocaleTimeString('id-ID', { 
        timeZone: 'Asia/Jakarta', hour12: false,
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
// 🛠️ FUNGSI FETCH DATA STOK (FIX AUTH ICS)
// ============================================================

// 1. KHFY Regular
async function getKHFYFullStock() {
    const params = new URLSearchParams();
    params.append('api_key', KHFY_KEY);
    const targetUrl = `${KHFY_BASE_URL}/list_product?${params.toString()}`;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); 
        const response = await fetch(targetUrl, { 
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/Direct' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);
        const json = await response.json();
        
        let dataList = [];
        if (json && json.data && Array.isArray(json.data)) dataList = json.data;
        else if (json && Array.isArray(json)) dataList = json;

        const stockMap = {};
        dataList.forEach(item => {
            stockMap[item.kode_produk] = {
                gangguan: item.gangguan == 1, 
                kosong: item.kosong == 1, 
                status: item.status,
                name: item.nama_produk
            };
        });
        return { list: dataList, map: stockMap };
    } catch (error) { return { error: error.message }; }
}

// 2. ICS Full Stock (FIXED: AUTH HEADERS)
async function getICSFullStock() {
    const params = new URLSearchParams();
    params.append('apikey', ICS_KEY); // Cara 1: URL Param
    const targetUrl = `${ICS_BASE_URL}/products?${params.toString()}`;
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); 
        
        const response = await fetch(targetUrl, { 
            method: 'GET', 
            headers: { 
                'User-Agent': 'Pandawa-Worker/Direct',
                'Authorization': `Bearer ${ICS_KEY}`, // Cara 2: Bearer Token (Utama)
                'token': ICS_KEY,                     // Cara 3: Header Token
                'Accept': 'application/json'
            }, 
            signal: controller.signal 
        });
        clearTimeout(timeoutId);
        
        // Cek Status HTTP
        if (response.status === 401 || response.status === 403) {
            return { list: [], map: {}, error: "Unauthorized: API Key Salah / Tidak Dikenali" };
        }

        const json = await response.json();
        
        let dataList = [];
        if (json && json.ready && Array.isArray(json.ready)) dataList = json.ready;
        else if (json && json.data && Array.isArray(json.data)) dataList = json.data;
        else if (Array.isArray(json)) dataList = json;
        else {
            return { list: [], map: {}, error: json.message || "Format Data Tidak Dikenali" };
        }

        const stockMap = {};
        dataList.forEach(item => {
            stockMap[item.code] = { 
                gangguan: item.status === 'gangguan' || item.status === 'error', 
                kosong: item.status === 'empty' || item.stock === 0 || item.status === 'kosong', 
                nonaktif: item.status === 'nonactive',
                real_stock: item.stock || 0,
                name: item.name,
                type: item.type
            };
        });
        return { list: dataList, map: stockMap };
    } catch (error) { 
        return { list: [], map: {}, error: error.message }; 
    }
}

// 3. KHFY V3 (Slot Akrab)
async function getKHFYAkrabSlots() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 20000); 
        const response = await fetch(KHFY_AKRAB_URL, { 
            method: 'GET', headers: { 'User-Agent': 'Pandawa-Worker/Direct' }, signal: controller.signal 
        });
        clearTimeout(timeoutId);
        const json = await response.json();
        const slotMap = {}; 
        if (json && json.ok === true && Array.isArray(json.data)) {
            json.data.forEach(item => {
                slotMap[item.type] = parseInt(item.sisa_slot || 0);
            });
            return slotMap;
        }
        return null;
    } catch (error) { return null; }
}

// 🔥 FUNGSI HIT PROVIDER (FIXED: AUTH HEADERS)
async function hitProviderDirect(serverType, data, isRecheck = false) {
    let targetUrl = '';
    let method = 'GET';
    let body = null;
    
    // Header Default dengan Auth ICS
    let headers = { 
        'User-Agent': 'Pandawa-Worker/Direct', 
        'Accept': 'application/json',
        'Authorization': `Bearer ${ICS_KEY}` // Tambahan Auth Header
    };

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
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER (FIXED AUTH MODE)...`);

    try {
        const snapshot = await db.collection('preorders').orderBy('timestamp', 'asc').limit(100).get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian.");
            return;
        }
        
        await sendTelegramLog("================================");

        // --- 1. AMBIL DATA LENGKAP ---
        const [khfyData, icsData, akrabSlotMap] = await Promise.all([
            getKHFYFullStock(), 
            getICSFullStock(),
            getKHFYAkrabSlots()
        ]);

        const stockMapKHFY = khfyData ? khfyData.map : null;
        const stockMapICS = icsData ? icsData.map : null;

        // --- 2. BUILD LAPORAN ---
        let reportMsg = "";

        // A. SLOT V3
        reportMsg += "📊 <b>SLOT AKRAB V3</b>\n";
        if (akrabSlotMap) {
            KHFY_SPECIAL_CODES.forEach(code => {
                const name = PRODUCT_NAMES[code] || code;
                const slot = akrabSlotMap[code] !== undefined ? akrabSlotMap[code] : '?';
                const icon = slot > 3 ? '🟢' : '🔴';
                reportMsg += `${icon} ${name}: <b>${slot}</b>\n`;
            });
        } else {
            reportMsg += "⚠️ Gagal mengambil data slot V3\n";
        }

        // Helper Status
        const printStatus = (item, source) => {
            let status = "Unknown";
            let icon = "⚪";
            if (source === 'ICS') {
                if (item.gangguan) { icon = "⛔"; status = "Gangguan"; }
                else if (item.kosong) { icon = "🔴"; status = "Kosong"; }
                else { icon = "✅"; status = `Ready (${item.real_stock})`; }
            } else {
                if (item.gangguan) { icon = "⛔"; status = "Gangguan"; }
                else if (item.kosong) { icon = "🔴"; status = "Kosong"; }
                else { icon = "✅"; status = "Ready"; }
            }
            return `${icon} <b>${item.code || item.kode_produk}</b>: ${status}\n`;
        };

        // B. DAFTAR PRODUK ICS
        reportMsg += "\n📡 <b>SERVER ICS</b>\n";
        if (icsData && icsData.list && icsData.list.length > 0) {
            const sortedIcs = icsData.list.sort((a,b) => (a.code||'').localeCompare(b.code||''));
            sortedIcs.forEach(i => {
                if (i.code && !i.code.toLowerCase().includes('tes')) {
                    reportMsg += printStatus(i, 'ICS');
                }
            });
        } else {
            const errMsg = icsData && icsData.error ? icsData.error : "Unknown Error";
            reportMsg += `⚠️ Gagal ICS: ${errMsg}\n`;
        }

        // C. DAFTAR PRODUK KHFY
        reportMsg += "\n📡 <b>SERVER KHFY</b>\n";
        if (khfyData && khfyData.list) {
            const khfyItems = khfyData.list.filter(i => {
                const c = (i.kode_produk || "").toUpperCase();
                const isSpecial = KHFY_SPECIAL_CODES.includes(c);
                return !isSpecial && (c.startsWith('FMX') || c.startsWith('CFMX') || c.startsWith('PLN') || c.startsWith('XLC') || c.startsWith('XLA'));
            });
            khfyItems.sort((a,b) => a.kode_produk.localeCompare(b.kode_produk));
            if (khfyItems.length > 0) {
                khfyItems.forEach(i => reportMsg += printStatus(i, 'KHFY'));
            } else {
                reportMsg += "<i>Tidak ada produk KHFY relevan</i>\n";
            }
        }

        await sendTelegramLog(reportMsg);

        // --- 3. PROSES TRANSAKSI (Sama) ---
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

            // === LOGIKA CEK STOK & SLOT ===
            let isSkip = false;
            let skipReason = '';

            // 1. CEK KHUSUS KHFY PRODUK SPESIAL
            if (serverType === 'KHFY' && KHFY_SPECIAL_CODES.includes(skuProduk)) {
                if (akrabSlotMap) {
                    const sisaSlot = akrabSlotMap[skuProduk];
                    const currentSlot = (sisaSlot !== undefined) ? sisaSlot : 0;
                    if (currentSlot <= 3) { 
                        isSkip = true;
                        skipReason = `Stok Kosong (Slot ${currentSlot})`;
                    }
                } else {
                    isSkip = true; skipReason = `Gagal Cek Slot V3`;
                }
            } 
            
            // 2. CEK STOK REGULAR
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

            // === SKIP & NOTIF ===
            if (isSkip) {
                console.log(`   ⛔ SKIP: ${skipReason}`);
                const skipNotifMsg = `${buyerName}-${skuProduk}-${tujuan}-Skip ${skipReason}`;
                await sendTelegramLog(skipNotifMsg);
                skippedTransactions.push({ buyer: buyerName, sku: skuProduk, dest: tujuan, reason: skipReason, server: serverType });
                continue; 
            }

            // === EKSEKUSI TRANSAKSI ===
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

        await sendTelegramLog("================================");
        console.log("\n--- SELESAI ---");

    } catch (error) { console.error("CRITICAL ERROR:", error); process.exit(1); }
}

runPreorderQueue();