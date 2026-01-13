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

// --- FUNGSI TEMBAK KE RELAY ---
async function hitVercelRelay(serverType, data) {
    let targetUrl = '';
    const params = new URLSearchParams();

    if (serverType === 'ICS') {
        params.append('action', 'createTransaction');
        params.append('apikey', ICS_KEY);
        params.append('kode_produk', data.sku);
        params.append('nomor_tujuan', data.tujuan);
        params.append('refid', data.reffId);
        targetUrl = `${VERCEL_DOMAIN}/api/relay?${params.toString()}`;
    } else {
        // KHFY
        params.append('api_key', KHFY_KEY);
        params.append('endpoint', '/trx'); 
        params.append('produk', data.sku); 
        params.append('tujuan', data.tujuan); 
        params.append('reff_id', data.reffId);
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    console.log(`      🚀 Menembak Relay Vercel (${serverType})...`);
    
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
            console.error("      ⚠️ Error Parse JSON:", text.substring(0, 100));
            return { status: false, message: "HTML Error / Server Pusat Gangguan", raw: text };
        }
    } catch (error) {
        console.error("      ⚠️ Gagal Koneksi Vercel:", error.message);
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

        for (const doc of snapshot.docs) {
            const po = doc.data();
            const poID = doc.id;
            const uidUser = po.uid; 
            
            if (po.debugStatus === 'TERBELI' || po.debugStatus === 'GAGAL') continue; 

            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            const serverType = po.serverType || 'KHFY'; 
            const reffId = `AUTO-${Date.now()}`;

            console.log(`\n🔹 TRX: ${poID} | ${skuProduk} -> ${tujuan}`);

            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP.`);
                await db.collection('preorders').doc(poID).update({ debugStatus: 'GAGAL', debugLogs: 'Data korup' });
                continue; 
            }

            // HIT RELAY
            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            const result = await hitVercelRelay(serverType, requestData);
            console.log("      📡 Respon:", JSON.stringify(result));

            // --- ANALISA HASIL (DIPERBAIKI) ---
            let isSuccess = false;
            let finalMessage = '-';
            let finalSN = '-';
            let trxIdProvider = '-';

            if (serverType === 'ICS') {
                // LOGIKA ICS
                if (result.success === true && result.data && result.data.status === 'success') {
                    isSuccess = true;
                    finalMessage = result.data.message; 
                    finalSN = result.data.sn || '-'; 
                    trxIdProvider = result.data.refid || '-';
                } else {
                    finalMessage = result.message || 'Gagal ICS';
                }

            } else {
                // === LOGIKA KHFY (REVISI) ===
                
                // 1. Normalisasi Data (Bisa Array atau Object)
                let dataItem = null;
                if (result.data) {
                    if (Array.isArray(result.data)) {
                        // Kasus 1: Array (Biasanya respon Cek Status/Riwayat)
                        dataItem = result.data[0];
                    } else {
                        // Kasus 2: Object (Biasanya respon Order Baru "akan di proses")
                        dataItem = result.data;
                    }
                }

                const msg = (result.msg || result.message || '').toLowerCase();
                const statusText = dataItem ? (dataItem.status_text || '') : '';
                
                // 2. Cek Kondisi Sukses
                const isExplicitSuccess = (statusText === 'SUKSES'); // Status tegas SUKSES
                const isQueued = (msg.includes('proses') || msg.includes('berhasil')); // Status "akan di proses"

                if (result.ok === true && (isExplicitSuccess || isQueued)) {
                    isSuccess = true;
                    
                    // Ambil TrxID Provider
                    trxIdProvider = dataItem.kode || dataItem.trxid || '-';
                    finalSN = dataItem.sn || 'Sedang Diproses';

                    // FORMAT PESAN
                    if (dataItem.kode_produk === 'CFMX' || (finalSN && finalSN.toLowerCase().includes('varian'))) {
                        // Case CFMX: Jika SN ada isinya varian, tampilkan. Jika masih diproses, info user.
                        if (finalSN === 'Sedang Diproses') {
                             finalMessage = `Cek Varian ${dataItem.produk || skuProduk} sedang diproses. Silakan cek riwayat sesaat lagi.`;
                        } else {
                             finalMessage = `${finalSN}. Tujuan: ${dataItem.tujuan || tujuan}`;
                        }
                    } else {
                        // Case Normal
                        const statusShow = statusText || "DIPROSES";
                        const produkShow = dataItem.kode_produk || dataItem.produk || skuProduk;
                        finalMessage = `${statusShow}. Produk: ${produkShow}. Tujuan: ${tujuan}. SN: ${finalSN}`;
                    }
                } else {
                    // Gagal
                    if (dataItem) {
                        finalMessage = dataItem.keterangan || dataItem.status_text || 'Gagal dari Pusat';
                    } else {
                        finalMessage = result.message || result.msg || 'Gagal/Maintenance';
                    }
                }
            }

            if (isSuccess) {
                console.log(`   ✅ SUKSES! Pesan: ${finalMessage}`);
                
                const historyId = po.historyId || `TRX-${Date.now()}`;
                
                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser,
                    trx_id: reffId,
                    trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    title: po.productName || skuProduk,
                    type: 'out',
                    amount: po.price || 0,
                    status: 'Sukses', // Status hijau di app user
                    dest_num: tujuan,
                    sn: finalSN,
                    trx_id_provider: trxIdProvider,
                    provider_code: skuProduk,
                    date: new Date().toISOString(),
                    api_msg: finalMessage,
                    balance_before: 0, 
                    balance_after: 0
                });

                await db.collection('preorders').doc(poID).update({
                    debugStatus: 'TERBELI',
                    successData: { code: skuProduk, price: po.price || 0 },
                    debugLogs: `[${new Date().toLocaleTimeString()}] ${finalMessage}`
                });
                
                await sendUserLog(uidUser, "Transaksi Berhasil", finalMessage, historyId);

            } else {
                console.log(`   ❌ GAGAL: ${finalMessage}`);
                await db.collection('preorders').doc(poID).update({
                    debugStatus: 'GAGAL',
                    debugLogs: `[${new Date().toLocaleTimeString()}] System: ${finalMessage}`
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