const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = 'chave.json';
const inputFile = 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      code === 0 ? resolve() : reject(new Error(`FFmpeg falhou (${code})`));
    });
  });
}

function registrarTemporario(arquivo) {
  arquivosTemporarios.push(arquivo);
}

function limparTemporarios() {
  console.log('🧹 Limpando arquivos temporários...');
  for (const arquivo of arquivosTemporarios) {
    if (fs.existsSync(arquivo)) fs.unlinkSync(arquivo);
  }
}

async function autenticar() {
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarArquivo(fileId, destino, auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => { registrarTemporario(destino); resolve(); });
    res.data.on('error', err => reject(err));
  });
}

async function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', video]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      code === 0 ? resolve(parseFloat(output.trim())) : reject(new Error('ffprobe falhou'));
    });
  });
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'fast',
    '-c:a', 'aac',
    '-y',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarOverlayRodape(input, output, rodape, logo, pontos) {
  let filtros = `[0:v]scale=1280:720[base];[1:v]scale=1280:720[rod];[2:v]scale=100:100[logo];`;

  let overlay = '';
  pontos.forEach((ponto, i) => {
    let fim = (ponto + 15).toFixed(3);
    overlay += `[base][rod]overlay=0:H-h:enable='between(t,${ponto},${fim})'[v${i}];`;
    filtros += `[v${i}]`;
  });

  filtros += `[logo]overlay=W-w-20:20[outv]`;

  const args = [
    '-i', input,
    '-i', rodape,
    '-i', logo,
    '-filter_complex', filtros + overlay,
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-crf', '23',
    '-preset', 'veryfast',
    '-c:a', 'aac',
    '-y',
    output
  ];

  await executarFFmpeg(args);
  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', '-y', saida]);
}

(async () => {
  try {
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const {
      id, video_principal, video_inicial, video_miraplay,
      videos_extras = [], video_final, logo_id, rodape_id, stream_url
    } = dados;

    await baixarArquivo(video_principal, 'principal.mp4', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await executarFFmpeg(['-i', 'principal.mp4', '-t', meio.toString(), '-c', 'copy', 'parte1.mp4']);
    await executarFFmpeg(['-i', 'principal.mp4', '-ss', meio.toString(), '-c', 'copy', 'parte2.mp4']);

    await reencode('parte1.mp4', 'parte1_720.mp4');
    await reencode('parte2.mp4', 'parte2_720.mp4');

    const rodapePath = 'rodape_overlay.mp4';
    await baixarArquivo(rodape_id, rodapePath, auth);
    await reencode(rodapePath, 'rodape_overlay_720.mp4');

    await aplicarOverlayRodape('parte1_720.mp4', 'parte1_final.mp4', 'rodape_overlay_720.mp4', 'logo.png', [180, 300]);
    await aplicarOverlayRodape('parte2_720.mp4', 'parte2_final.mp4', 'rodape_overlay_720.mp4', 'logo.png', [180, 300]);

    const arquivos = ['parte1_final.mp4'];

    for (const vid of [video_inicial, video_miraplay, ...videos_extras, video_inicial]) {
      if (!vid) continue;
      const nome = `tmp_${vid}.mp4`;
      await baixarArquivo(vid, nome, auth);
      const saida = `re_${vid}.mp4`;
      await reencode(nome, saida);
      arquivos.push(saida);
    }

    arquivos.push('parte2_final.mp4');

    if (video_final) {
      await baixarArquivo(video_final, 'fim.mp4', auth);
      await reencode('fim.mp4', 'fim_re.mp4');
      arquivos.push('fim_re.mp4');
    }

    await unirVideos(arquivos, 'video_final_completo.mp4');

    if (stream_url) {
      fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, id }, null, 2));
    }

    limparTemporarios();

  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
