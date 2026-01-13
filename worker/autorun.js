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
async function hitVercelRelay(serverType, data, isRecheck = false) {
    let targetUrl = '';
    const params = new URLSearchParams();

    if (serverType === 'ICS') {
        // ICS
        if (isRecheck) {
             params.append('action', 'checkStatus'); // Sesuaikan action cek status ICS jika ada
        } else {
             params.append('action', 'createTransaction');
        }
        params.append('apikey', ICS_KEY);
        params.append('kode_produk', data.sku);
        params.append('nomor_tujuan', data.tujuan);
        params.append('refid', data.reffId);
        targetUrl = `${VERCEL_DOMAIN}/api/relay?${params.toString()}`;
    } else {
        // KHFY
        params.append('api_key', KHFY_KEY);
        
        // PENTING: Jika Re-Check, gunakan endpoint history/status
        if (isRecheck) {
            params.append('endpoint', '/history'); // Endpoint cek status
        } else {
            params.append('endpoint', '/trx'); // Endpoint order
        }

        params.append('produk', data.sku); 
        params.append('tujuan', data.tujuan); 
        params.append('reff_id', data.reffId);
        targetUrl = `${VERCEL_DOMAIN}/api/relaykhfy?${params.toString()}`;
    }

    if (!isRecheck) console.log(`      🚀 Menembak Relay Vercel (${serverType})...`);
    else console.log(`      🔎 Re-Check Status (${serverType})...`);
    
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
        // LIMIT 100
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
            
            // Skip yang sudah Terbeli (jika ada sisa)
            if (po.debugStatus === 'TERBELI') continue; 

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

            // 1. HIT PERTAMA (ORDER)
            const requestData = { sku: skuProduk, tujuan: tujuan, reffId: reffId };
            let result = await hitVercelRelay(serverType, requestData, false);
            
            // --- LOGIKA "WAIT & RE-CHECK" ---
            // Jika server KHFY bilang "akan di proses", kita TIDAK boleh percaya dulu.
            // Kita harus tunggu 6 detik, lalu cek status lagi.
            
            if (serverType !== 'ICS') {
                const msgAwal = (result.msg || result.message || '').toLowerCase();
                const isQueued = msgAwal.includes('proses') || msgAwal.includes('berhasil');
                
                if (result.ok === true && isQueued) {
                    console.log(`      ⏳ Respon: "Akan Diproses". Menunggu 6 detik untuk hasil final...`);
                    
                    // Delay 6 Detik
                    await new Promise(r => setTimeout(r, 6000));
                    
                    // 2. HIT KEDUA (CEK STATUS / HISTORY)
                    // Kita tembak ulang relay dengan data yang sama (reffId sama),
                    // Relay KHFY akan mengarahkannya ke endpoint /history (lihat fungsi hitVercelRelay)
                    const checkResult = await hitVercelRelay(serverType, requestData, true);
                    
                    // Ganti hasil 'result' dengan hasil cek status terbaru
                    if (checkResult.ok === true || checkResult.data) {
                        console.log(`      📡 Hasil Re-Check diterima.`);
                        result = checkResult; 
                    } else {
                        console.log(`      ⚠️ Re-Check gagal/timeout. Menggunakan respon awal.`);
                    }
                }
            }
            
            console.log("      📡 Respon Final:", JSON.stringify(result));

            // --- ANALISA HASIL ---
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
                // LOGIKA KHFY
                let dataItem = null;
                // Normalisasi Data Array/Object
                if (result.data) {
                    if (Array.isArray(result.data)) dataItem = result.data[0];
                    else dataItem = result.data;
                }

                const msg = (result.msg || result.message || '').toLowerCase();
                const statusText = dataItem ? (dataItem.status_text || '') : '';
                
                // Indikator Sukses
                const isExplicitSuccess = (statusText === 'SUKSES'); 
                // Jika setelah re-check masih "akan di proses", kita anggap Pending (belum sukses total)
                // Tapi user minta hapus kalau sukses. Jadi kita harus strict.
                // Hanya status 'SUKSES' yang dianggap sukses final.
                
                if (result.ok === true && isExplicitSuccess) {
                    isSuccess = true;
                    
                    trxIdProvider = dataItem.kode || dataItem.trxid || '-';
                    finalSN = dataItem.sn || '-';

                    // Format Pesan
                    if (dataItem.kode_produk === 'CFMX' || (finalSN && finalSN.toLowerCase().includes('varian'))) {
                         finalMessage = `${finalSN}. Tujuan: ${dataItem.tujuan || tujuan}`;
                    } else {
                        finalMessage = `${statusText}. Produk: ${dataItem.kode_produk}. Tujuan: ${tujuan}. SN: ${finalSN}`;
                    }
                } else {
                    // Masih Pending atau Gagal
                    if (dataItem) {
                        finalMessage = dataItem.keterangan || dataItem.status_text || 'Pending/Gagal';
                    } else {
                        finalMessage = result.message || result.msg || 'Gagal/Maintenance';
                    }
                }
            }

            if (isSuccess) {
                console.log(`   ✅ SUKSES FINAL! Pesan: ${finalMessage}`);
                
                const historyId = po.historyId || `TRX-${Date.now()}`;
                
                // 1. Simpan ke History User
                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser,
                    trx_id: reffId,
                    trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    title: po.productName || skuProduk,
                    type: 'out',
                    amount: po.price || 0,
                    status: 'Sukses',
                    dest_num: tujuan,
                    sn: finalSN,
                    trx_id_provider: trxIdProvider,
                    provider_code: skuProduk,
                    date: new Date().toISOString(),
                    api_msg: finalMessage,
                    balance_before: 0, 
                    balance_after: 0
                });

                // 2. HAPUS DARI ANTRIAN (Sesuai Request)
                console.log(`   🗑️ Menghapus dari antrian Preorder...`);
                await db.collection('preorders').doc(poID).delete();
                
                // 3. Kirim Notif
                await sendUserLog(uidUser, "Transaksi Berhasil", finalMessage, historyId);

            } else {
                console.log(`   ⏳ BELUM SUKSES (Retry Nanti): ${finalMessage}`);
                
                // Update Logs saja, status JANGAN GAGAL biar retry lagi
                await db.collection('preorders').doc(poID).update({
                    debugLogs: `[${new Date().toLocaleTimeString()}] ${finalMessage}`
                });
            }

            // Jeda 2 detik antar user
            await new Promise(r => setTimeout(r, 2000));
        }

    } catch (error) {
        console.error("CRITICAL ERROR:", error);
        process.exit(1);
    }
    console.log("\n--- SELESAI ---");
}

runPreorderQueue();