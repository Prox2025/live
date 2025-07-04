const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Executando FFmpeg:\nffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`❌ FFmpeg falhou com código ${code}`));
    });
  });
}

function registrarTemporario(arquivo) {
  arquivosTemporarios.push(arquivo);
}

function limparTemporarios() {
  console.log('🧹 Limpando arquivos temporários...');
  for (const arquivo of arquivosTemporarios) {
    try {
      if (fs.existsSync(arquivo)) {
        fs.unlinkSync(arquivo);
        console.log(`🗑️ Removido: ${arquivo}`);
      }
    } catch (e) {
      console.warn(`⚠️ Falha ao remover ${arquivo}:`, e.message);
    }
  }
}

async function autenticar() {
  console.log('🔐 Autenticando no Google Drive...');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  console.log('🔓 Autenticação concluída com sucesso.');
  return client;
}

async function baixarArquivo(fileId, destino, auth) {
  console.log(`📥 Baixando do Drive\nID: ${fileId}\n→ ${destino}`);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      console.log(`✅ Download finalizado: ${destino}`);
      registrarTemporario(destino);
      resolve();
    });
    res.data.on('error', err => reject(err));
  });
}

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
      else reject(new Error('❌ ffprobe falhou'));
    });
  });
}

async function cortarVideo(input, out1, out2, meio) {
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
  registrarTemporario(out1);
  registrarTemporario(out2);
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=960:ih*960/iw,crop=960:720', // Proporção 4:3, zoom para preencher
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

function gerarTemposAleatoriosComIntervalo(duracao, quantidade, intervaloMin, intervaloMax) {
  const tempos = [];
  let tentativa = 0;

  while (tempos.length < quantidade && tentativa < 1000) {
    tentativa++;
    const t = Math.floor(Math.random() * (duracao - 50));
    if (
      tempos.every(e => Math.abs(e - t) > intervaloMin && Math.abs(e - t) < intervaloMax)
    ) {
      tempos.push(t);
    }
  }

  tempos.sort((a, b) => a - b);
  return tempos;
}

async function aplicarRodapeVideoReal(input, output, rodapeVideo, logo, duracaoPrincipal) {
  const duracaoRodape = await obterDuracao(rodapeVideo);
  const tempos = gerarTemposAleatoriosComIntervalo(duracaoPrincipal, 2, duracaoRodape + 120, duracaoRodape + 180);
  console.log(`🎞️ Aplicando rodapé nos tempos:`, tempos);

  const filtros = [];
  let base = '[0:v]';

  tempos.forEach((inicio, i) => {
    const fim = inicio + duracaoRodape;
    filtros.push(
      `[1:v]trim=start=0:duration=${duracaoRodape},setpts=PTS-STARTPTS[rodape${i}]`,
      `[rodape${i}]scale=720:72[rodape_scaled${i}]`,
      `[rodape_scaled${i}]format=rgba[rodape_f${i}]`,
      `${base}[rodape_f${i}]overlay=0:H-72:enable='between(t,${inicio},${fim})'[tmp${i}]`
    );
    base = `[tmp${i}]`;
  });

  filtros.push(`[2:v]scale=150:-1[logo]`);
  filtros.push(`${base}[logo]overlay=W-w-10:10[final]`);

  const args = [
    '-i', input,           // [0:v] principal
    '-i', rodapeVideo,     // [1:v] rodapé
    '-i', logo,            // [2:v] logo
    '-filter_complex', filtros.join('; '),
    '-map', '[final]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-preset', 'veryfast',
    '-crf', '23',
    output
  ];

  await executarFFmpeg(args);
  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
  console.log(`🎬 Vídeo final criado: ${saida}`);
}

(async () => {
  try {
    console.log('📦 Lendo input.json...');
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const obrigatorios = ['id', 'video_principal', 'logo_id', 'rodape_id', 'video_inicial', 'video_miraplay', 'video_final'];
    const faltando = obrigatorios.filter(k => !dados[k]);
    if (faltando.length) throw new Error('❌ input.json incompleto:\n' + faltando.map(f => `- ${f}`).join('\n'));

    const {
      id, video_principal, logo_id, rodape_id,
      videos_extras = [], video_inicial, video_miraplay, video_final, stream_url
    } = dados;

    await baixarArquivo(rodape_id, 'rodape_video.mp4', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    await aplicarRodapeVideoReal('parte1_re.mp4', 'parte1_final.mp4', 'rodape_video.mp4', 'logo.png', meio);
    await aplicarRodapeVideoReal('parte2_re.mp4', 'parte2_final.mp4', 'rodape_video.mp4', 'logo.png', duracao - meio);

    const videoIds = [
      video_inicial,
      video_miraplay,
      ...videos_extras,
      video_final
    ];

    const arquivosProntos = ['parte1_final.mp4', 'parte2_final.mp4'];

    for (let i = 0; i < videoIds.length; i++) {
      const idVideo = videoIds[i];
      if (!idVideo) continue;
      if (idVideo.endsWith('.mp4') && fs.existsSync(idVideo)) {
        arquivosProntos.push(idVideo);
        continue;
      }
      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}.mp4`;
      await baixarArquivo(idVideo, raw, auth);
      await reencode(raw, final);
      arquivosProntos.push(final);
    }

    await unirVideos(arquivosProntos, 'video_final_completo.mp4');

    if (stream_url && id) {
      fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, id, video_id: id }, null, 2));
      console.log('💾 stream_info.json criado.');
    }

    limparTemporarios();

  } catch (error) {
    console.error('🚨 ERRO:', error.message);
    limparTemporarios();
    process.exit(1);
  }
})();
