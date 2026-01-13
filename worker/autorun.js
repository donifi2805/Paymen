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

// --- 2. KONFIGURASI VERCEL RELAY (Backend Anda) ---
// Ganti domain ini dengan domain Vercel/Website Anda yang aktif
// Contoh: "https://pandawa-store.vercel.app" atau "https://www.pandawa-digital.store"
const VERCEL_DOMAIN = "https://www.pandawa-digital.store"; 

// API Key tetap diambil dari Secrets
const KHFY_KEY = process.env.KHFY_API_KEY; 
const ICS_KEY = process.env.ICS_API_KEY; // Tambahkan secret ini jika pakai ICS

// --- FUNGSI TEMBAK KE RELAY VERCEL ---
async function hitVercelRelay(serverType, payload) {
    let targetUrl = '';
    
    // Siapkan URL Params
    const params = new URLSearchParams(payload);

    if (serverType === 'ICS') {
        // Logika sesuai file api/relay.js Anda
        // Target: /api/relay?action=...&apikey=...
        params.append('apikey', ICS_KEY); 
        targetUrl = `${VERCEL_DOMAIN}/api/relay?${params.toString()}`;
    } else {
        // Logika sesuai file api/relaykhfy.js Anda
        // Target: /api/relaykhfy?endpoint=/order&api_key=...
        params.append('api_key', KHFY_KEY);
        
        // Kita gunakan endpoint /order untuk transaksi
        params.append('endpoint', '/order'); 
        
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    console.log(`      🚀 Menembak Relay Vercel (${serverType})...`);
    
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 Detik Timeout

        // Kita gunakan GET karena relay Anda meneruskan query params
        const response = await fetch(targetUrl, { 
            method: 'GET',
            headers: {
                'User-Agent': 'Pandawa-Worker/1.0'
            },
            signal: controller.signal 
        });
        clearTimeout(timeoutId);

        const text = await response.text();
        try {
            return JSON.parse(text);
        } catch (e) {
            console.error("      ⚠️ Error Parse JSON Relay:", text.substring(0, 100));
            return { status: false, message: "Invalid JSON from Relay" };
        }
    } catch (error) {
        console.error("      ⚠️ Gagal Koneksi ke Vercel:", error.message);
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
        // Ambil antrian Preorder
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
            
            // Mapping Data
            const skuProduk = po.productCode || po.provider || po.code;
            const tujuan = po.targetNumber || po.target || po.tujuan;
            const serverType = po.serverType || 'KHFY'; // KHFY atau ICS
            const reffId = `AUTO-${Date.now()}`;

            console.log(`\n🔹 TRX: ${poID} | ${skuProduk} -> ${tujuan}`);

            if (!skuProduk || !tujuan) {
                console.log(`   ❌ DATA TIDAK LENGKAP. Skip.`);
                await db.collection('preorders').doc(poID).delete();
                continue; 
            }

            // --- EKSEKUSI VIA RELAY ---
            // Payload disesuaikan dengan provider
            let payload = {};
            if (serverType === 'ICS') {
                payload = {
                    action: 'order', // Sesuaikan action order ICS
                    service: skuProduk,
                    target: tujuan,
                    ref_id: reffId
                };
            } else {
                // KHFY
                payload = {
                    action: 'order',
                    service: skuProduk,
                    target: tujuan,
                    ref_id: reffId
                };
            }

            // PANGGIL FUNGSI RELAY
            const result = await hitVercelRelay(serverType, payload);
            console.log("      📡 Respon:", JSON.stringify(result));

            // --- ANALISA HASIL ---
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
                // KHFY Logic
                const status = result.status === true || result.ok === true;
                const msg = (result.message || result.msg || '').toLowerCase();
                isSuccess = status || msg.includes('sukses') || msg.includes('proses');
                
                if (result.data) {
                    sn = result.data.sn || result.data.message || 'Sedang Diproses';
                    trxIdProvider = result.data.trxid || result.data.id || '-';
                }
            }

            if (isSuccess) {
                console.log(`   ✅ SUKSES! Memindahkan ke History User...`);

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

                // Hapus dari antrian Preorder
                await db.collection('preorders').doc(poID).delete();
                
                // Notif
                await sendUserLog(uidUser, "Transaksi Berhasil", `Order ${skuProduk} sukses. SN: ${sn}`, historyId);

            } else {
                const errMsg = result.message || result.msg || (result.data ? result.data.pesan : 'Gagal');
                console.log(`   ❌ GAGAL: ${errMsg}`);
                
                // Update status di Preorder (Jangan dihapus, biar Admin tau)
                await db.collection('preorders').doc(poID).update({
                    debugStatus: 'GAGAL',
                    debugLogs: `[${new Date().toLocaleTimeString()}] System: ${errMsg}`
                });
            }

            // Jeda 2 detik
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        process.exit(1);
    }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();