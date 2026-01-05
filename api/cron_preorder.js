// api/cron_preorder.js
import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// --- KONFIGURASI KUNCI FIREBASE ADMIN ---
// SANGAT PENTING: Anda harus memiliki Service Account Key dari Firebase Console
// Settings -> Service Accounts -> Generate New Private Key
// Simpan isinya di Environment Variable Vercel atau (HANYA UNTUK TEST) hardcode di sini object-nya.
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT || '{}');

if (!getApps().length) {
    initializeApp({
        credential: cert(serviceAccount)
    });
}

const db = getFirestore();

// Config API (Diambil dari file yang Anda upload)
const KHFY_CONFIG = { 
    apiKey: "8F1199C1-483A-4C96-825E-F5EBD33AC60A", 
    baseUrl: "https://panel.khfy-store.com/api_v2" 
};
const ICS_CONFIG = { 
    apiKey: "7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77", 
    baseUrl: "https://api.ics-store.my.id/api/reseller" 
};

export default async function handler(req, res) {
    // Logika Cron Job
    try {
        console.log("[CRON] Memulai pengecekan Preorder...");
        
        // 1. Ambil Antrian Preorder
        const snapshot = await db.collection('preorders').orderBy('timestamp', 'asc').get();
        
        if (snapshot.empty) {
            return res.status(200).json({ message: 'Tidak ada antrian preorder.' });
        }

        let processed = 0;
        let successCount = 0;

        // 2. Loop setiap antrian
        for (const doc of snapshot.docs) {
            const data = doc.data();
            const poId = doc.id;
            
            // Cek apakah status sudah terbeli (double protection)
            if (data.debugStatus === 'TERBELI') continue;

            console.log(`[RUN] Memproses ${data.productName} ke ${data.targetNumber}`);

            const serverType = data.serverType || 'KHFY'; // Default Khfy jika null
            const reffId = `AUTO-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
            let result = null;
            let isSuccess = false;
            let sn = '';
            let finalPrice = 0;

            // 3. Eksekusi Transaksi (Logic mirip executeDebugTrx)
            try {
                if (serverType === 'ICS') {
                    // --- LOGIC ICS ---
                    const icsUrl = `${ICS_CONFIG.baseUrl}/trx?apikey=${ICS_CONFIG.apiKey}`;
                    const icsBody = {
                        product_code: data.provider, // Kode Produk
                        dest_number: data.targetNumber,
                        ref_id_custom: reffId
                    };
                    
                    const apiRes = await fetch(icsUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(icsBody)
                    });
                    result = await apiRes.json();
                    
                    if (result.success === true && result.data) {
                        isSuccess = true;
                        // ICS biasanya pending dulu, kita anggap masuk proses
                        // Kita perlu cek status, tapi untuk auto-buy, kalau status 'Pending' atau 'Sukses' kita anggap berhasil order
                        if(result.data.status === 'Gagal') isSuccess = false;
                        sn = result.data.message || 'Proses Server ICS';
                        finalPrice = result.data.price || 0;
                    }
                } else {
                    // --- LOGIC KHFY ---
                    const khfyUrl = `${KHFY_CONFIG.baseUrl}/trx?api_key=${KHFY_CONFIG.apiKey}&kode_produk=${data.provider}&tujuan=${data.targetNumber}&reff_id=${reffId}`;
                    const apiRes = await fetch(khfyUrl);
                    result = await apiRes.json();

                    // Cek Sukses Khfy
                    if (result.ok || result.status) {
                         const msg = (result.message || '').toLowerCase();
                         if (msg.includes('sukses') || msg.includes('proses')) {
                             isSuccess = true;
                             if(result.data) {
                                sn = result.data.sn || result.data.message || 'Proses Server Khfy';
                                finalPrice = result.data.price || 0;
                             }
                         }
                    }
                }
            } catch (err) {
                console.error(`[ERROR API] ${serverType}:`, err.message);
            }

            // 4. Handle Hasil
            if (isSuccess) {
                successCount++;
                console.log(`[SUKSES] ${data.targetNumber} Berhasil dibeli!`);

                // A. Update History User (Set Sukses)
                const historyId = data.historyId || `PO-${poId}`;
                const historyRef = db.collection('users').doc(data.uid).collection('history').doc(historyId);
                
                // Cek data history dulu
                const histSnap = await historyRef.get();
                if (histSnap.exists && histSnap.data().status === 'Pending') {
                    await historyRef.update({
                        status: 'Sukses',
                        api_msg: `Auto Run: ${sn}`,
                        trx_id: reffId, // Update Ref ID baru
                        date_updated: new Date().toISOString()
                        // Optional: Update harga beli asli (laba rugi) di sini jika perlu
                    });
                }

                // B. Hapus dari Preorder (Karena sudah sukses)
                await db.collection('preorders').doc(poId).delete();

            } else {
                console.log(`[GAGAL/STOK HABIS] ${data.targetNumber}. Membiarkan di antrian untuk run berikutnya.`);
                // Update log di dokumen preorder agar admin tau ini sudah dicoba
                await db.collection('preorders').doc(poId).update({
                    debugStatus: 'RETRY', // Tetap bisa diambil query lagi
                    debugLogs: `[${new Date().toLocaleTimeString()}] Gagal: ${JSON.stringify(result)}\n`
                });
            }
            
            processed++;
        }

        return res.status(200).json({ 
            success: true, 
            processed: processed, 
            success_trx: successCount,
            message: "Cron job finished." 
        });

    } catch (error) {
        console.error("Cron Error:", error);
        return res.status(500).json({ error: error.message });
    }
}
