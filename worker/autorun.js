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
// Pastikan domain ini benar
const VERCEL_DOMAIN = "https://www.pandawa-digital.store"; 
const KHFY_KEY = process.env.KHFY_API_KEY; 
const ICS_KEY = process.env.ICS_API_KEY; 

// --- FUNGSI TEMBAK KE RELAY (SESUAI PANELADMIN.HTML) ---
async function hitVercelRelay(serverType, data) {
    let targetUrl = '';
    const params = new URLSearchParams();

    if (serverType === 'ICS') {
        // === LOGIKA SERVER ICS ===
        // Sesuai paneladmin.html: action=createTransaction
        // Endpoint: /api/relay
        params.append('action', 'createTransaction');
        params.append('apikey', ICS_KEY);
        params.append('kode_produk', data.sku);
        params.append('nomor_tujuan', data.tujuan);
        params.append('refid', data.reffId);
        
        targetUrl = `${VERCEL_DOMAIN}/api/relay?${params.toString()}`;

    } else {
        // === LOGIKA SERVER KHFY ===
        // Sesuai paneladmin.html: endpoint=/trx
        // Params: produk, tujuan, reff_id
        
        params.append('api_key', KHFY_KEY);
        params.append('endpoint', '/trx'); // WAJIB /trx agar relaykhfy.js paham
        params.append('produk', data.sku); // Relay minta 'produk', bukan 'service'
        params.append('tujuan', data.tujuan); // Relay minta 'tujuan', bukan 'target'
        params.append('reff_id', data.reffId);
        
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    console.log(`      🚀 Menembak Relay Vercel (${serverType})...`);
    console.log(`      🔗 URL: ${targetUrl}`); // Debug URL untuk memastikan benar
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 Detik Timeout

        // Gunakan GET sesuai paneladmin.html
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
            console.error("      ⚠️ Error Parse JSON. Raw Response:", text.substring(0, 100));
            return { status: false, message: "HTML Error: Server Pusat Gangguan/Maintenance", raw: text };
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

// --- 3. LOGIKA UTAMA (PREORDER QUEUE) ---
async function runPreorderQueue() {
    console.log(`[${new Date().toISOString()}] MEMULAI CEK PREORDER QUEUE...`);

    try {
        const snapshot = await db.collection('preorders')
                                 .orderBy('timestamp', 'asc') 
                                 .limit(10)
                                 .get();

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
            const reffId = `AUTO-${Date.now()}`;

            console.log(`\n🔹 TRX: ${poID} | ${skuProduk} -> ${tujuan}`);

            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP. Hapus.`);
                await db.collection('preorders').doc(poID).delete();
                continue; 
            }

            // Siapkan Data untuk Relay
            const requestData = {
                sku: skuProduk,
                tujuan: tujuan,
                reffId: reffId
            };

            // EKSEKUSI
            const result = await hitVercelRelay(serverType, requestData);
            console.log("      📡 Respon:", JSON.stringify(result));

            // ANALISA HASIL
            let isSuccess = false;
            let sn = '-';
            let trxIdProvider = '-';

            if (serverType === 'ICS') {
                isSuccess = (result.success === true);
                if(result.data) {
                    sn = result.data.message || result.data.sn || 'Proses';
                    trxIdProvider = result.data.trxid || '-';
                }
            } else {
                // Logic KHFY (Dari Relay)
                const status = result.status === true || result.ok === true;
                const msg = (result.message || result.msg || '').toLowerCase();
                isSuccess = status || msg.includes('sukses') || msg.includes('proses');
                
                if (result.data) {
                    sn = result.data.sn || result.data.message || 'Sedang Diproses';
                    trxIdProvider = result.data.trxid || result.data.id || '-';
                }
            }

            if (isSuccess) {
                console.log(`   ✅ SUKSES! Pindah ke History...`);
                
                const historyId = po.historyId || `TRX-${Date.now()}`;
                
                // Simpan ke History User
                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser,
                    trx_id: reffId,
                    trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    title: po.productName || skuProduk,
                    type: 'out',
                    amount: po.price || 0,
                    status: 'Sukses',
                    dest_num: tujuan,
                    sn: sn,
                    trx_id_provider: trxIdProvider,
                    provider_code: skuProduk,
                    date: new Date().toISOString(),
                    api_msg: `Auto Run: ${sn}`,
                    balance_before: 0, 
                    balance_after: 0
                });

                // Hapus Antrian
                await db.collection('preorders').doc(poID).delete();
                
                // Kirim Notif
                await sendUserLog(uidUser, "Transaksi Berhasil", `Order ${skuProduk} sukses. SN: ${sn}`, historyId);

            } else {
                const errMsg = result.message || result.msg || (result.data ? result.data.pesan : 'Gagal Relay');
                console.log(`   ❌ GAGAL: ${errMsg}`);
                
                // Update Error di Preorder (Jangan hapus, biar dicek admin)
                await db.collection('preorders').doc(poID).update({
                    debugStatus: 'GAGAL',
                    debugLogs: `[${new Date().toLocaleTimeString()}] System: ${errMsg}`
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