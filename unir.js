const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const path = require('path');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function registrarTemporario(caminho) {
  arquivosTemporarios.push(caminho);
}

function executarFFmpeg(args, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-y', ...args]);
    ffmpeg.stderr.on('data', (data) => process.stderr.write(data));
    ffmpeg.on('close', (code) => {
      if (code === 0) {
        if (output) console.log(`✅ Criado: ${output}`);
        resolve();
      } else {
        reject(new Error(`FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function autenticar() {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarArquivo(id, destino, auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId: id, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destino);
    res.data.pipe(out);
    res.data.on('end', () => {
      registrarTemporario(destino);
      console.log(`📥 Baixado: ${destino}`);
      resolve();
    });
    res.data.on('error', reject);
  });
}

async function obterParametrosVideo(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate',
      '-of', 'json',
      video
    ]);

    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => {
      const json = JSON.parse(data);
      const stream = json.streams[0];
      const [num, den] = stream.r_frame_rate.split('/').map(Number);
      resolve({
        width: stream.width,
        height: stream.height,
        framerate: num / den
      });
    });
    ffprobe.on('error', reject);
  });
}

async function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video]);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => resolve(parseFloat(data.trim())));
    ffprobe.on('error', reject);
  });
}

async function cortarParteComReencode(video, inicio, duracao, saida) {
  await executarFFmpeg([
    '-i', video,
    '-ss', inicio.toString(),
    '-t', duracao.toString(),
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '128k',
    saida
  ], saida);
}

async function reencodarParaPadrao(entrada, saida, ref) {
  const scale = `${ref.width}:${ref.height}`;
  const fr = ref.framerate.toFixed(2);
  await executarFFmpeg([
    '-i', entrada,
    '-vf', `scale=${scale},fps=${fr}`,
    '-c:v', 'libx264',
    '-preset', 'slow',
    '-crf', '20',
    '-c:a', 'aac',
    '-b:a', '128k',
    saida
  ], saida);
}

async function aplicarLogo(video, output, logoPath) {
  await executarFFmpeg([
    '-i', video,
    '-i', logoPath,
    '-filter_complex', '[1]scale=-1:75[logo];[0][logo]overlay=W-w:0',
    '-c:a', 'copy',
    output
  ], output);
}

async function unirVideos(listaVideos, saida) {
  const listaTxt = 'inputs.txt';
  fs.writeFileSync(listaTxt, listaVideos.map(v => `file '${path.resolve(v)}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', listaTxt, '-c', 'copy', saida], saida);
  registrarTemporario(listaTxt);
}

async function baixarEReencodarPadrao(id, nomeBase, ref, auth) {
  const raw = `raw_${nomeBase}.mp4`;
  const final = `ok_${nomeBase}.mp4`;
  await baixarArquivo(id, raw, auth);
  await reencodarParaPadrao(raw, final, ref);
  return final;
}

async function main() {
  const auth = await autenticar();
  const input = JSON.parse(fs.readFileSync(inputFile));

  // 🎯 Baixar vídeo principal e extrair padrão
  const videoPrincipalRaw = `raw_principal.mp4`;
  await baixarArquivo(input.video_principal, videoPrincipalRaw, auth);
  const ref = await obterParametrosVideo(videoPrincipalRaw);
  const duracaoTotal = await obterDuracao(videoPrincipalRaw);
  const meio = duracaoTotal / 2;

  // ✂️ Cortar parte1 e parte2 com reencode
  await cortarParteComReencode(videoPrincipalRaw, 0, meio, 'parte1.mp4');
  await cortarParteComReencode(videoPrincipalRaw, meio, duracaoTotal - meio, 'parte2.mp4');

  // 🖼️ Aplicar logo nas partes
  if (input.logo_id) {
    await baixarArquivo(input.logo_id, 'logo.png', auth);
    await aplicarLogo('parte1.mp4', 'parte1_logo.mp4', 'logo.png');
    await aplicarLogo('parte2.mp4', 'parte2_logo.mp4', 'logo.png');
  } else {
    fs.renameSync('parte1.mp4', 'parte1_logo.mp4');
    fs.renameSync('parte2.mp4', 'parte2_logo.mp4');
  }

  // 📥 Reencodar demais vídeos
  const arquivos = {};
  arquivos.inicial = await baixarEReencodarPadrao(input.video_inicial, 'inicial', ref, auth);
  arquivos.miraplay = await baixarEReencodarPadrao(input.video_miraplay, 'miraplay', ref, auth);
  arquivos.final = await baixarEReencodarPadrao(input.video_final, 'final', ref, auth);

  arquivos.extras = [];
  for (let i = 0; i < (input.videos_extras || []).length; i++) {
    const extra = await baixarEReencodarPadrao(input.videos_extras[i], `extra${i}`, ref, auth);
    arquivos.extras.push(extra);
  }

  // 🧩 Ordem de montagem
  const ordem = [
    'parte1_logo.mp4',
    arquivos.inicial,
    arquivos.miraplay,
    ...arquivos.extras,
    arquivos.inicial,
    'parte2_logo.mp4',
    arquivos.final
  ];

  // 🧱 Unir tudo
  await unirVideos(ordem, 'video_final_completo.mp4');

  // 📊 Gerar info
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  const stats = fs.statSync('video_final_completo.mp4');
  const tamanhoMB = (stats.size / (1024 * 1024)).toFixed(2);

  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id || null,
    stream_url: input.stream_url || null,
    duracao_segundos: duracaoFinal,
    tamanho_mb: parseFloat(tamanhoMB),
    criado_em: new Date().toISOString()
  }, null, 2));

  console.log('✅ Vídeo final pronto: video_final_completo.mp4');
  console.log(`⏱️  Duração total: ${duracaoFinal.toFixed(2)} segundos`);
  console.log(`💾 Tamanho final: ${tamanhoMB} MB`);
}

main().catch(console.error);
