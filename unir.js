const { google } = require('googleapis');
const fs = require('fs');

const keyFile = 'chave.json';  // arquivo JSON da conta de serviço
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const fileId = '1jc0VZY1LSvryCvZKYJMcINt4Vw0rEUns';  // novo ID do arquivo no Drive

(async () => {
  try {
    // Autenticação com a conta de serviço usando a chave JSON
    const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
    const client = await auth.getClient();

    // Instancia Google Drive API
    const drive = google.drive({ version: 'v3', auth: client });

    // Cria stream de escrita para salvar o arquivo localmente
    const dest = fs.createWriteStream('logo_teste.png');

    // Solicita download do arquivo como stream
    const res = await drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    // Pipe para salvar no disco
    res.data.pipe(dest);

    // Quando terminar de escrever, loga sucesso
    dest.on('finish', () => {
      console.log('✅ Logo baixado com sucesso');
    });

    // Caso ocorra erro ao salvar arquivo
    dest.on('error', err => {
      console.error('❌ Erro ao salvar o arquivo:', err.message);
    });
  } catch (err) {
    // Caso erro na requisição ou autenticação
    console.error('❌ Erro ao baixar o logo:', err.response?.data || err.message);
  }
})();
