const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

process.on('unhandledRejection', err => {
  console.error('💥 UNHANDLED PROMISE REJECTION:', err);
  process.exit(1);
});

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

// Executa comando FFmpeg
function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log('🔧 Executando ffmpeg:', ['ffmpeg', ...args].join(' '));
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg falhou com código ${code}`));
    });
  });
}

// Autenticação Google Drive
async function autenticar() {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await auth.getClient();
}

// Baixa arquivo do Google Drive
async function baixarArquivo(fileId, destino, auth) {
  const drive = google.drive({ version: 'v3', auth });
  console.log(`⬇️ Baixando arquivo ID ${fileId} para ${destino}`);
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    let tamanho = 0;
    res.data.on('data', chunk => tamanho += chunk.length);
    res.data.pipe(output);
    output.on('finish', () => {
      console.log(`✅ Download concluído (${(tamanho / 1024 / 1024).toFixed(2)} MB)`);
      resolve();
    });
    output.on('error', err => reject(err));
  });
}

// Obter duração do vídeo com ffprobe
function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) resolve(parseFloat(output.trim()));
      else reject(new Error('Erro ao obter duração com ffprobe'));
    });
  });
}

// Corta vídeo em duas partes
async function cortarVideo(input, out1, out2, meio) {
  console.log(`✂️ Cortando vídeo em ${input} ao meio (${meio} s)`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
}

// Reencoda vídeo para 1280x720, 30fps
async function reencode(input, output) {
  console.log(`⚙️ Reencodando vídeo ${input} → ${output}`);
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720,fps=30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
}

// Junta vídeos da lista
async function unirVideos(lista, saida) {
  console.log(`🎬 Unindo vídeos: ${lista.join(', ')}`);
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
}

(async () => {
  try {
    console.log('✅ Iniciando unir.js');
    if (!fs.existsSync(inputFile)) {
      throw new Error(`Arquivo de entrada não encontrado: ${inputFile}`);
    }

    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const videoPrincipal = dados.video_principal;
    const extras = dados.videos_opcionais || [];
    const id = dados.id || 'video_unido';

    // Baixar vídeo principal
    await baixarArquivo(videoPrincipal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    // Cortar e reencodar partes
    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1.mp4');
    await reencode('parte2_raw.mp4', 'parte2.mp4');

    // Processar vídeos extras
    const intermediarios = [];
    for (let i = 0; i < extras.length; i++) {
      const vid = extras[i];
      const raw = `extra${i}_raw.mp4`;
      const out = `extra${i}.mp4`;

      await baixarArquivo(vid, raw, auth);
      await reencode(raw, out);
      intermediarios.push(out);
    }

    const ordemFinal = ['parte1.mp4', ...intermediarios, 'parte2.mp4'];
    await unirVideos(ordemFinal, 'video_unido.mp4');

    // Remove arquivos intermediários para limpeza
    const arquivosRemover = ['principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', ...intermediarios.map(f => f.replace('.mp4', '_raw.mp4')), ...intermediarios];
    arquivosRemover.forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });

    console.log('✅ Vídeo unido criado com sucesso: video_unido.mp4');
  } catch (err) {
    console.error('❌ Erro em unir.js:', err);
    process.exit(1);
  }
})();
