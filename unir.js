const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// Carrega o input.json
const input = JSON.parse(fs.readFileSync('input.json', 'utf8'));

// Autentica com o Google Drive usando chave de serviço
const auth = new google.auth.GoogleAuth({
  keyFile: 'chave.json',
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
});
const drive = google.drive({ version: 'v3', auth });

async function baixarArquivo(id, nomeArquivo) {
  const dest = fs.createWriteStream(nomeArquivo);
  try {
    const res = await drive.files.get(
      { fileId: id, alt: 'media' },
      { responseType: 'stream' }
    );

    console.log(`📥 Baixando ${nomeArquivo}...`);
    await new Promise((resolve, reject) => {
      res.data
        .on('end', () => {
          console.log(`✅ Download concluído: ${nomeArquivo}`);
          resolve();
        })
        .on('error', err => {
          console.error(`❌ Erro ao baixar ${nomeArquivo}:`, err.message);
          reject(err);
        })
        .pipe(dest);
    });
  } catch (err) {
    console.error(`⚠️ Erro ao baixar o vídeo (${id}):`, err.message);
  }
}

async function main() {
  const downloads = [
    { id: input.video_inicial, nome: 'video_inicial.mp4' },
    { id: input.video_principal, nome: 'video_principal.mp4' },
    { id: input.video_miraplay, nome: 'video_miraplay.mp4' },
    { id: input.video_final, nome: 'video_final.mp4' },
    { id: input.logo_id, nome: 'logo.png' },
  ];

  if (Array.isArray(input.videos_extras)) {
    input.videos_extras.slice(0, 5).forEach((extraId, index) => {
      downloads.push({
        id: extraId,
        nome: `extra_${index + 1}.mp4`
      });
    });
  }

  for (const item of downloads) {
    if (item.id) {
      await baixarArquivo(item.id, item.nome);
    }
  }
}

main().catch(err => {
  console.error('❌ Erro geral:', err);
});
