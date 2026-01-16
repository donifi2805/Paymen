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
        if (isRecheck) params.append('endpoint', '/history'); // Menggunakan endpoint cek status/history
        else params.append('endpoint', '/trx');
        params.append('produk', data.sku); 
        params.append('tujuan', data.tujuan); 
        params.append('reff_id', data.reffId);
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    if (!isRecheck) console.log(`      🚀 Menembak Relay Vercel (${serverType})...`);
    else console.log(`      🔍 Checking Real Status (${serverType})...`);
    
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

            // ==========================================
            // 1. SMART STICKY REFF ID (KUNCI ID)
            // ==========================================
            let reffId = po.active_reff_id;
            if (!reffId) {
                reffId = `AUTO-${Date.now()}`; 
                console.log(`   🔐 Mengunci Reff ID Baru: ${reffId}`);
                await db.collection('preorders').doc(poID).update({ active_reff_id: reffId });
            } else {
                console.log(`   🔒 Menggunakan Reff ID Lama: ${reffId}`);
            }

            console.log(`\n🔹 TRX: ${poID} | ${skuProduk} -> ${tujuan}`);

            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP.`);
                await db.collection('preorders').doc(poID).delete(); 
                continue; 
            }

            // CEK STOK LOKAL
            if (serverType === 'KHFY' && stockMap && stockMap[skuProduk]) {
                const infoProduk = stockMap[skuProduk];
                if (infoProduk.gangguan === 1 || infoProduk.kosong === 1) {
                    const statusMsg = infoProduk.gangguan === 1 ? 'SEDANG GANGGUAN' : 'STOK KOSONG';
                    console.log(`   ⛔ SKIP (Pre-Check): ${statusMsg}`);
                    await db.collection('preorders').doc(poID).update({
                        debugLogs: `[${new Date().toLocaleTimeString()}] [SKIP-HEMAT] ${statusMsg}`
                    });
                    continue; 
                }
            }

            // HIT RELAY UTAMA
            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            let result = await hitVercelRelay(serverType, requestData, false);

            // ==========================================
            // 2. DETEKSI DUPLIKAT & CEK STATUS ASLI
            // ==========================================
            // Kita cek apakah server bilang "Sudah Pernah" atau "Duplicate"
            let msgRaw = (result.msg || result.message || (result.data ? result.data.message : '')).toLowerCase();
            let isDuplicate = msgRaw.includes('sudah ada') || msgRaw.includes('sudah pernah') || msgRaw.includes('duplicate') || msgRaw.includes('exists');

            // Tambahan logika tunggu KHFY
            if (serverType !== 'ICS' && !isDuplicate) {
                const isQueued = msgRaw.includes('proses') || msgRaw.includes('berhasil') || msgRaw.includes('pending');
                if (result.ok === true && isQueued) {
                    console.log(`      ⏳ Respon Awal OK. Menunggu 5 detik lalu Cek Status...`);
                    await new Promise(r => setTimeout(r, 5000));
                    // Ubah jadi mode cek status
                    isDuplicate = true; 
                }
            }

            // JIKA TERDETEKSI DUPLIKAT / PERLU CEK STATUS
            if (isDuplicate) {
                console.log(`      ⚠️ Transaksi dianggap duplikat/pending. Melakukan RE-CHECK ke Server...`);
                // KITA MEMAKSA CEK STATUS MENGGUNAKAN REFF ID YANG SAMA
                const checkResult = await hitVercelRelay(serverType, requestData, true);
                
                // Jika hasil cek status valid, kita pakai hasil ini sebagai hasil final (Menimpa hasil error duplikat tadi)
                if (checkResult && (checkResult.ok === true || checkResult.data)) {
                    console.log(`      ✅ Data Status Asli Ditemukan.`);
                    result = checkResult; 
                }
            }
            
            console.log("      📡 Respon Final (Setelah Analisa):", JSON.stringify(result));

            // ==========================================
            // 3. ANALISA HASIL FINAL
            // ==========================================
            let isSuccess = false;
            let finalMessage = '-';
            let finalSN = '-';
            let trxIdProvider = '-';
            let isStockEmpty = false;
            let isHardFail = false; 
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
                        if (msg.includes('kosong') || msg.includes('ditutup')) isStockEmpty = true;
                        
                        // Kuncinya disini: Kalau status 'failed', berarti transaksi ID ini GAGAL TOTAL.
                        // Maka kita harus Hard Fail agar ID dibuang.
                        isHardFail = true; 
                        finalMessage = result.data.message;
                    } else {
                        // Pending
                        finalMessage = result.data.message || 'Pending';
                    }
                } 
                if (!isSuccess && !isStockEmpty && !isHardFail) finalMessage = result.message || 'Gagal/Pending ICS';

            } else {
                // KHFY Logic
                let dataItem = null;
                if (result.data) {
                    if (Array.isArray(result.data)) dataItem = result.data[0];
                    else dataItem = result.data;
                }
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
                    const msg = (result.msg || result.message || '').toLowerCase();
                    if (msg.includes('stok kosong') || msg.includes('#gagal')) {
                        isStockEmpty = true;
                        isHardFail = true; 
                        finalMessage = msg;
                    } 
                    else if (dataItem && dataItem.status_text === 'GAGAL') {
                        // Server bilang GAGAL (bukan pending)
                        isHardFail = true;
                        finalMessage = dataItem.keterangan || 'Transaksi Gagal';
                    }
                    else {
                        // Masih Pending / Timeout
                        if (dataItem) finalMessage = dataItem.keterangan || dataItem.status_text || 'Pending';
                        else finalMessage = result.message || 'Pending/Maintenance';
                    }
                }
            }

            // ==========================================
            // 4. KEPUTUSAN AKHIR (DATABASE)
            // ==========================================
            if (isSuccess) {
                console.log(`   ✅ SUKSES! Pesan: ${finalMessage}`);
                const historyId = po.historyId || `TRX-${Date.now()}`;
                let finalTitle = po.productName || skuProduk;
                if (!finalTitle.toLowerCase().includes('preorder')) finalTitle = `[PreOrder] ${finalTitle}`;

                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser, trx_id: reffId, trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    title: finalTitle, type: 'out', amount: po.price || 0, status: 'Sukses',
                    dest_num: tujuan, sn: finalSN, trx_id_provider: trxIdProvider, provider_code: skuProduk,
                    date: new Date().toISOString(), api_msg: finalMessage, balance_before: 0, balance_after: 0,
                    is_preorder: true, 
                    raw_provider_json: JSON.stringify(result), // JSON ASLI DARI HASIL CEK STATUS
                    provider_source: serverType
                });

                await sendUserLog(uidUser, "PreOrder Berhasil", `Sukses: ${finalTitle}`, historyId);
                console.log(`   🗑️ Pesanan Selesai. Menghapus dari antrian Preorder...`);
                await db.collection('preorders').doc(poID).delete();

            } else {
                // GAGAL
                if (isHardFail) {
                     // INI LOGIKA PENTING YANG ANDA MINTA:
                     // Karena status cek hasilnya GAGAL (bukan pending), maka ID ini sudah "kotor".
                     // Kita hapus active_reff_id agar next run pakai ID BARU.
                     console.log(`   ⚠️ HARD FAIL (ReffID ini Gagal): ${finalMessage}. Resetting Reff ID...`);
                     await db.collection('preorders').doc(poID).update({
                        active_reff_id: admin.firestore.FieldValue.delete(), 
                        debugLogs: `[${new Date().toLocaleTimeString()}] [FAIL-RESET] ${finalMessage}`
                    });
                } else {
                    // Masih PENDING / TIMEOUT / DUPLICATE tapi belum sukses
                    // Kita pertahankan ID nya.
                    console.log(`   ⏳ SOFT FAIL (Pending/Cek Lagi Nanti): ${finalMessage}. ID Tetap.`);
                    await db.collection('preorders').doc(poID).update({
                        debugLogs: `[${new Date().toLocaleTimeString()}] [PENDING-KEEP] ${finalMessage}`
                    });
                }
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