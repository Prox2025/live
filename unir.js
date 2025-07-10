const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];
const arquivosTemporarios = [];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`🚨 ERRO: FFmpeg falhou (${code})`));
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
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  return await auth.getClient();
}

async function baixarArquivo(fileId, destino, auth) {
  if (!fileId) throw new Error(`❌ ID ausente para o arquivo: ${destino}`);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      console.log(`✅ Baixado: ${destino}`);
      registrarTemporario(destino);
      resolve();
    });
    res.data.on('error', err => reject(err));
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    proc.stdout.on('data', chunk => output += chunk.toString());
    proc.on('close', code => {
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

async function aplicarRodapeELogo(input, output, rodapeVideo, logo, duracao) {
  const duracaoRodape = await obterDuracao(rodapeVideo);
  const tempos = [180, 300]; // segundos fixos: minuto 3 e 5

  const filtros = [
    `[0:v]scale=1280:720[base]`,
    `[1:v]scale=1280:720[rod]`,
    `[2:v]scale=iw*0.1:-1,setpts=PTS-STARTPTS[logo]`
  ];

  let last = 'base';
  tempos.forEach((start, i) => {
    const end = (start + duracaoRodape).toFixed(3);
    const over = `[${last}][rod]overlay=0:H-h:enable='between(t,${start},${end})'[v${i}]`;
    filtros.push(over);
    last = `v${i}`;
  });

  filtros.push(`[${last}][logo]overlay=W-w-20:20[outv]`);

  const args = [
    '-i', input,
    '-i', rodapeVideo,
    '-i', logo,
    '-filter_complex', filtros.join(';'),
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-y', output
  ];

  await executarFFmpeg(args);
  registrarTemporario(output);
}

async function reencode(input, output) {
  await executarFFmpeg([
    '-i', input,
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  registrarTemporario(txt);
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
}

(async () => {
  try {
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const obrigatorios = ['id', 'video_principal', 'logo_id', 'rodape_id', 'video_inicial', 'video_miraplay', 'video_final'];
    const faltando = obrigatorios.filter(k => !dados[k]);
    if (faltando.length) throw new Error(`❌ input.json incompleto:\n` + faltando.map(f => `- ${f}`).join('\n'));

    const {
      id, video_principal, logo_id, rodape_id,
      videos_extras = [], video_inicial, video_miraplay, video_final, stream_url
    } = dados;

    await baixarArquivo(rodape_id, 'rodape.mp4', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_720.mp4');
    await reencode('parte2_raw.mp4', 'parte2_720.mp4');

    await aplicarRodapeELogo('parte1_720.mp4', 'parte1_final.mp4', 'rodape.mp4', 'logo.png', meio);
    await aplicarRodapeELogo('parte2_720.mp4', 'parte2_final.mp4', 'rodape.mp4', 'logo.png', duracao - meio);

    const arquivos = [];

    async function baixarEPreparar(idVideo, nome) {
      const raw = `${nome}_raw.mp4`;
      const final = `${nome}_720.mp4`;
      await baixarArquivo(idVideo, raw, auth);
      await reencode(raw, final);
      arquivos.push(final);
    }

    await baixarEPreparar(video_inicial, 'video_inicial');
    await baixarEPreparar(video_miraplay, 'video_mira');

    for (let i = 0; i < videos_extras.length; i++) {
      if (videos_extras[i]) {
        await baixarEPreparar(videos_extras[i], `extra${i}`);
      }
    }

    await baixarEPreparar(video_final, 'video_final');

    const ordem = [
      'parte1_final.mp4',
      'video_inicial_720.mp4',
      'video_mira_720.mp4',
      ...arquivos,
      'video_inicial_720.mp4',
      'parte2_final.mp4',
      'video_final_720.mp4'
    ];

    await unirVideos(ordem, 'video_final_completo.mp4');
    fs.writeFileSync('stream_info.json', JSON.stringify({ id, stream_url }, null, 2));
    console.log('✅ Vídeo final criado com sucesso!');
    limparTemporarios();

  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
