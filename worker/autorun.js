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

// --- HELPER: SAFE FETCH ---
async function safeFetchRelay(url, method = 'GET', body = null) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000); 

    try {
        const options = {
            method: method,
            headers: { 
                'User-Agent': 'Pandawa-Worker/5.0-NoDelete',
                'Content-Type': 'application/json'
            },
            signal: controller.signal
        };
        
        if (body && method === 'POST') options.body = JSON.stringify(body);

        const response = await fetch(url, options);
        clearTimeout(timeout);

        const contentType = response.headers.get("content-type");
        const text = await response.text();

        if (!contentType || !contentType.includes("application/json")) {
            return { 
                ok: false, 
                isHtmlError: true, 
                msg: `Respon Server Bukan JSON. Raw: ${text.substring(0, 50)}...` 
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
        return { ok: false, msg: `Network Error: ${error.message}` };
    }
}

// --- FUNGSI TEMBAK KE RELAY ---
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
        if (isRecheck) {
            params.append('endpoint', '/status'); 
            params.append('reff_id', data.reffId);
        } else {
            params.append('endpoint', '/trx');
            params.append('produk', data.sku);
            params.append('tujuan', data.tujuan);
            params.append('reff_id', data.reffId);
        }
        
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    if (!isRecheck) console.log(`      🚀 Menembak Relay (${serverType})...`);
    else console.log(`      🔍 Cek Status Terakhir (${serverType})...`);
    
    const result = await safeFetchRelay(targetUrl, 'GET');

    if (result.ok) {
        return result.data; 
    } else {
        return { 
            status: false, 
            success: false, 
            message: result.msg || "Koneksi Gagal/Timeout",
            is_network_error: true 
        };
    }
}

// --- HELPER: ANALISA HASIL ---
function analyzeResult(serverType, result, isCheckMode = false) {
    let status = 'PENDING'; 
    let msg = 'Sedang diproses';
    let sn = '-';
    let trxIdProvider = '-';
    let isStockEmpty = false;

    if (result.is_network_error) {
        return { status: 'NETWORK_ERROR', msg: result.message };
    }

    if (serverType === 'ICS') {
        if (result.data) {
            const d = result.data;
            if (d.status === 'success' || d.status === 'Sukses') {
                status = 'SUKSES';
                msg = d.message || 'Sukses';
                sn = d.sn || '-';
                trxIdProvider = d.refid;
            } else if (d.status === 'failed' || d.status === 'Gagal') {
                status = 'GAGAL';
                msg = d.message;
                if (msg.toLowerCase().includes('kosong')) isStockEmpty = true;
            } else {
                status = 'PENDING';
                msg = d.message || 'Pending';
                if (isCheckMode && msg.toLowerCase().includes('tidak ditemukan')) status = 'NOT_FOUND';
            }
        }
    } 
    else { // KHFY
        let dataItem = null;
        if (result.data) {
            if (Array.isArray(result.data)) dataItem = result.data[0];
            else dataItem = result.data;
        }

        const statusText = dataItem ? (dataItem.status_text || '') : '';
        const rawMsg = (result.msg || result.message || '').toLowerCase();

        if (statusText === 'SUKSES') {
            status = 'SUKSES';
            sn = dataItem.sn;
            trxIdProvider = dataItem.trxid;
            msg = `${statusText} SN:${sn}`;
        } else if (statusText === 'GAGAL') {
            status = 'GAGAL';
            msg = dataItem.keterangan;
        } else {
            if (rawMsg.includes('sukses')) {
                status = 'SUKSES';
                msg = 'Sukses (Detected by msg)';
            } else if (rawMsg.includes('gagal') || rawMsg.includes('habis') || rawMsg.includes('kosong')) {
                status = 'GAGAL';
                msg = rawMsg;
            } else if (rawMsg.includes('data tidak ditemukan') || (dataItem && dataItem.status === 'error')) {
                status = 'NOT_FOUND';
            }
        }
        if (msg.toLowerCase().includes('kosong') || msg.toLowerCase().includes('habis')) isStockEmpty = true;
    }

    return { status, msg, sn, trxIdProvider, isStockEmpty, raw: result };
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

// --- 3. LOGIKA UTAMA (ANTI HAPUS ANTRIAN) ---
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI WORKER (PREORDER MODE: NO DELETE)...`);

    try {
        const snapshot = await db.collection('preorders').orderBy('timestamp', 'asc').limit(50).get();

        if (snapshot.empty) {
            console.log("ℹ️ Tidak ada antrian.");
            return;
        }

        console.log(`✅ DITEMUKAN ${snapshot.size} ANTRIAN.`);

        for (const doc of snapshot.docs) {
            const po = doc.data();
            const poID = doc.id;
            const uidUser = po.uid;
            
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            const serverType = po.serverType || 'KHFY'; 
            
            let reffId = po.fixed_reff_id; 
            if (!reffId) {
                reffId = po.order_id || `TRX-${Date.now()}-${Math.floor(Math.random()*1000)}`;
                await db.collection('preorders').doc(poID).update({ fixed_reff_id: reffId });
            }

            console.log(`\n🔹 CEK: ${skuProduk} -> ${tujuan}`);

            if (!skuProduk || !tujuan) {
                // Hapus hanya jika data korup/rusak total
                await db.collection('preorders').doc(poID).delete(); 
                continue; 
            }

            // 1. CEK STATUS DULU
            const checkData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            const checkRaw = await hitVercelRelay(serverType, checkData, true);
            const checkAnalysis = analyzeResult(serverType, checkRaw, true);

            let executionResult = null;

            if (checkAnalysis.status === 'SUKSES') {
                console.log(`   ✅ SUDAH SUKSES DI SERVER!`);
                executionResult = checkAnalysis; 
            } 
            else if (checkAnalysis.status === 'GAGAL') {
                console.log(`   ❌ SUDAH GAGAL DI SERVER!`);
                executionResult = checkAnalysis;
            }
            else if (checkAnalysis.status === 'NETWORK_ERROR') {
                console.log(`   ⚠️ Skip (Network Error).`);
                continue; 
            }
            else {
                // NOT FOUND / PENDING -> LAKUKAN PEMBELIAN
                if (checkAnalysis.status === 'NOT_FOUND' || checkAnalysis.status === 'PENDING') {
                     const buyRaw = await hitVercelRelay(serverType, checkData, false);
                     
                     if (serverType !== 'ICS' && !buyRaw.is_network_error) {
                         console.log("      ⏳ Sinkronisasi KHFY (5s)...");
                         await new Promise(r => setTimeout(r, 5000));
                         const recheckRaw = await hitVercelRelay(serverType, checkData, true);
                         if (recheckRaw && !recheckRaw.is_network_error && recheckRaw.data) {
                             executionResult = analyzeResult(serverType, recheckRaw);
                         } else {
                             executionResult = analyzeResult(serverType, buyRaw);
                         }
                     } else {
                         executionResult = analyzeResult(serverType, buyRaw);
                     }
                }
            }

            if (!executionResult) executionResult = { status: 'PENDING', msg: 'Unknown State' };
            const finalMsg = executionResult.msg;
            
            // ==========================================
            // LOGIKA PENENTU NASIB ANTRIAN
            // ==========================================
            
            if (executionResult.status === 'SUKSES') {
                // --- KASUS 1: SUKSES (HANYA INI YANG MENGHAPUS ANTRIAN) ---
                console.log(`   🎉 SUKSES: Pindah ke History`);
                const historyId = po.historyId || `TRX-${Date.now()}`;
                let finalTitle = po.productName || skuProduk;
                if (!finalTitle.toLowerCase().includes('preorder')) finalTitle = `[PreOrder] ${finalTitle}`;

                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser, trx_id: reffId, 
                    title: finalTitle, type: 'out', amount: po.price || 0, 
                    status: 'Sukses',
                    dest_num: tujuan, sn: executionResult.sn, 
                    trx_id_provider: executionResult.trxIdProvider, provider_code: skuProduk,
                    date: new Date().toISOString(), api_msg: finalMsg, 
                    is_preorder: true, provider_source: serverType
                }, { merge: true });

                await sendUserLog(uidUser, "Transaksi Berhasil", `Sukses: ${finalTitle}`, historyId);
                
                // HAPUS DARI ANTRIAN KARENA SUDAH SELESAI
                await db.collection('preorders').doc(poID).delete(); 

            } else if (executionResult.status === 'GAGAL' || executionResult.isStockEmpty) {
                // --- KASUS 2: GAGAL (TETAP DI ANTRIAN) ---
                // "Tolong hilangkan Vonis Gagal yang otomatis menghapus data"
                console.log(`   ⛔ GAGAL (Ditahan di Antrian): ${finalMsg}`);
                
                // UPDATE LOG DOKUMEN PREORDER (TIDAK DELETE, TIDAK REFUND)
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] [RESPON GAGAL] ${finalMsg}`,
                    last_provider_status: 'GAGAL',
                    last_error_message: finalMsg,
                    retry_count: admin.firestore.FieldValue.increment(1) // Hitung berapa kali gagal
                });
                
                // DATA TETAP ADA DI ANTRIAN. 
                // Script akan mencoba lagi di putaran berikutnya (Looping sampai stok ada/sukses).

            } else {
                // --- KASUS 3: PENDING / ERROR LAIN ---
                console.log(`   🔄 PENDING: ${finalMsg}`);
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] [RETRY] ${finalMsg}`
                });
            }
            
            await new Promise(r => setTimeout(r, 1500));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
    }
    console.log("\n--- SELESAI ---\n");
}

runPreorderQueue();