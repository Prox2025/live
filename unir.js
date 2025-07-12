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

async function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video]);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => resolve(parseFloat(data.trim())));
    ffprobe.on('error', reject);
  });
}

async function cortarMetade(video, parte1, parte2) {
  const duracao = await obterDuracao(video);
  const meio = duracao / 2;

  await executarFFmpeg(['-i', video, '-t', meio.toString(), '-c', 'copy', parte1], parte1);
  await executarFFmpeg(['-i', video, '-ss', meio.toString(), '-c', 'copy', parte2], parte2);
}

async function reencodarEntrada(entrada, saida) {
  await executarFFmpeg(['-i', entrada, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-b:a', '128k', saida], saida);
}

async function aplicarLogo(video, output, logoPath) {
  await executarFFmpeg([
    '-i', video,
    '-i', logoPath,
    '-filter_complex', '[1]scale=-1:80[logo];[0][logo]overlay=W-w-20:20',
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

async function main() {
  const auth = await autenticar();
  const input = JSON.parse(fs.readFileSync(inputFile));

  const arquivos = {};

  async function baixarEReencodar(id, nomeBase) {
    const raw = `raw_${nomeBase}.mp4`;
    const final = `ok_${nomeBase}.mp4`;
    await baixarArquivo(id, raw, auth);
    await reencodarEntrada(raw, final);
    return final;
  }

  // Baixar e dividir vídeo principal
  const videoPrincipal = await baixarEReencodar(input.video_principal, 'principal');
  await cortarMetade(videoPrincipal, 'parte1.mp4', 'parte2.mp4');

  // Aplicar logo nas partes 1 e 2
  if (input.logo_id) {
    await baixarArquivo(input.logo_id, 'logo.png', auth);
    await aplicarLogo('parte1.mp4', 'parte1_logo.mp4', 'logo.png');
    await aplicarLogo('parte2.mp4', 'parte2_logo.mp4', 'logo.png');
  } else {
    fs.renameSync('parte1.mp4', 'parte1_logo.mp4');
    fs.renameSync('parte2.mp4', 'parte2_logo.mp4');
  }

  // Baixar e reencodar os demais vídeos
  arquivos.inicial = await baixarEReencodar(input.video_inicial, 'inicial');
  arquivos.miraplay = await baixarEReencodar(input.video_miraplay, 'miraplay');
  arquivos.final = await baixarEReencodar(input.video_final, 'final');

  arquivos.extras = [];
  for (let i = 0; i < (input.videos_extras || []).length; i++) {
    const extra = await baixarEReencodar(input.videos_extras[i], `extra${i}`);
    arquivos.extras.push(extra);
  }

  // Ordem final dos vídeos
  const ordem = [
    'parte1_logo.mp4',
    arquivos.inicial,
    arquivos.miraplay,
    ...arquivos.extras,
    arquivos.inicial, // repetido
    'parte2_logo.mp4',
    arquivos.final
  ];

  // União final
  await unirVideos(ordem, 'video_final_completo.mp4');

  // Obter informações finais
  const duracaoFinal = await obterDuracao('video_final_completo.mp4');
  const stats = fs.statSync('video_final_completo.mp4');
  const tamanhoMB = (stats.size / (1024 * 1024)).toFixed(2);

  // Criar stream_info.json com dados completos
  fs.writeFileSync('stream_info.json', JSON.stringify({
    id: input.id || null,
    stream_url: input.stream_url || null,
    duracao_segundos: duracaoFinal,
    tamanho_mb: parseFloat(tamanhoMB),
    criado_em: new Date().toISOString()
  }, null, 2));

  // Exibir no terminal
  console.log('✅ Vídeo final pronto: video_final_completo.mp4');
  console.log(`⏱️  Duração total: ${duracaoFinal.toFixed(2)} segundos`);
  console.log(`💾 Tamanho final: ${tamanhoMB} MB`);
}

main().catch(console.error);
