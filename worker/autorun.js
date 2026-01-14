// --- DATABASE ACTION (PENYELESAIAN PESANAN) ---
            if (isSuccess) {
                console.log(`   ✅ SUKSES! Pesan: ${finalMessage}`);
                
                const historyId = po.historyId || `TRX-${Date.now()}`;
                
                // NAMA PRODUK KITA MODIFIKASI DISINI
                let finalTitle = po.productName || skuProduk;
                // Tambahkan label PreOrder jika belum ada
                if (!finalTitle.toLowerCase().includes('preorder')) {
                    finalTitle = `[PreOrder] ${finalTitle}`;
                }

                // 1. PINDAHKAN KE RIWAYAT TRANSAKSI
                await db.collection('users').doc(uidUser).collection('history').doc(historyId).set({
                    uid: uidUser, 
                    trx_id: reffId, 
                    trx_code: Math.floor(100000 + Math.random() * 900000).toString(),
                    
                    // --- MODIFIKASI JUDUL AGAR TERLIHAT BEDA ---
                    title: finalTitle, 
                    // -------------------------------------------
                    
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
                    balance_after: 0,
                    
                    // FIELD TAMBAHAN UNTUK SYSTEM (Biar Admin mudah filter nanti)
                    is_preorder: true, 
                    
                    // REQ: DATA MENTAH
                    raw_provider_json: JSON.stringify(result), 
                    provider_source: serverType
                });

                // 2. KIRIM NOTIFIKASI
                await sendUserLog(uidUser, "PreOrder Berhasil", `Sukses: ${finalTitle}`, historyId);
                
                // 3. HAPUS DARI ANTRIAN
                console.log(`   🗑️ Pesanan Selesai. Menghapus dari antrian Preorder...`);
                await db.collection('preorders').doc(poID).delete();

            } 
            // ... (kode else if stok kosong dan else retry tetap sama)