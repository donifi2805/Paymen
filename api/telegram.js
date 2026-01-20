// --- UPDATE: FUNGSI INI LEBIH PINTAR MENANGKAP PESAN ERROR ---
async function executeTransaction(poData) {
    const { targetNumber, provider, serverType, id } = poData;
    const reffId = `BOT-${Date.now()}-${id.substring(0,4)}`;
    
    try {
        let url = '';
        if (serverType === 'KHFY') {
            url = `${BASE_URL}/api/relaykhfy?endpoint=/trx&produk=${provider}&tujuan=${targetNumber}&reff_id=${reffId}`;
        } else {
            // Default ICS
            let icsType = 'xda';
            if(String(provider).toUpperCase().startsWith('XCL')) icsType = 'circle';
            else if(String(provider).toUpperCase().startsWith('XLA')) icsType = 'xla';
            
            url = `${BASE_URL}/api/relay?action=createTransaction&apikey=7274410f84b7e2810795810e879a4e0be8779c451d55e90e29d9bc174547ff77&kode_produk=${provider}&nomor_tujuan=${targetNumber}&refid=${reffId}&type=${icsType}`;
        }

        const res = await fetch(url);
        const json = await res.json();
        
        let isSuccess = false;
        
        // --- LOGIKA BARU PENANGKAPAN PESAN (SN) ---
        // Kita cari pesan di semua kemungkinan field agar tidak muncul "Proses Bot"
        let sn = json.message || json.msg || 'Gagal tanpa alasan'; 

        if (json.data) {
            if (json.data.message) sn = json.data.message;
            else if (json.data.sn) sn = json.data.sn;
            else if (json.data.note) sn = json.data.note;
        }

        // --- CEK STATUS SUKSES ---
        if (serverType === 'KHFY') {
            const msg = (json.message || json.msg || '').toLowerCase();
            isSuccess = (json.status === true || json.ok === true || msg.includes('sukses') || msg.includes('proses'));
        } else {
            isSuccess = json.success === true;
        }

        return { success: isSuccess, sn: sn, raw: json };
    } catch (e) {
        return { success: false, sn: "Error Fetch: " + e.message, raw: null };
    }
}