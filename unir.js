const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');
const path = require('path');

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
      else reject(new Error(`❌ FFmpeg falhou (${code})`));
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
  console.log(`📥 Baixando do Drive ID: ${fileId} → ${destino}`);
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
    '-vf', "scale=1280:720",
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarOverlayRodape(input, output, rodapePath, logoPath, tempos) {
  // comando FFmpeg corrigido para filtro complexo sem espaços extras e labels consistentes
  const filtros = `[0:v]scale=1280:720[base];` +
    `[1:v]format=rgba,setpts=PTS-STARTPTS[rod];` +
    `[2:v]scale=100:100[logo];` +
    `[base][rod]overlay=0:'if(between(t,${tempos[0]},${tempos[0] + 15}), ` +
    `if(lt(t,${tempos[0] + 1}), H-(H-h)*(t-${tempos[0]}), ` +
    `if(lt(t,${tempos[1] - 1}), H-h, ` +
    `if(lt(t,${tempos[1]}), H-h+(H-h)*(t-${tempos[1] - 1}), NAN))), NAN)'[tmp1];` +
    `[tmp1][rod]overlay=0:'if(between(t,${tempos[1]},${tempos[1] + 15}), ` +
    `if(lt(t,${tempos[1] + 1}), H-(H-h)*(t-${tempos[1]}), ` +
    `if(lt(t,${tempos[1] + 14}), H-h, ` +
    `if(lt(t,${tempos[1] + 15}), H-h+(H-h)*(t-${tempos[1] + 14}), NAN))), NAN)'[tmp2];` +
    `[tmp2][logo]overlay=W-w-20:20[outv]`;

  const args = [
    '-i', input,
    '-i', rodapePath,
    '-i', logoPath,
    '-filter_complex', filtros,
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

    // Baixar arquivos do Drive
    const rodapePath = rodape_id.endsWith('.mp4') ? 'rodape.mp4' : 'rodape.png';
    await baixarArquivo(rodape_id, rodapePath, auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);

    await reencode('parte1_raw.mp4', 'parte1_720.mp4');
    await reencode('parte2_raw.mp4', 'parte2_720.mp4');

    await aplicarOverlayRodape('parte1_720.mp4', 'parte1_final.mp4', rodapePath, 'logo.png', [180, 300]);
    await aplicarOverlayRodape('parte2_720.mp4', 'parte2_final.mp4', rodapePath, 'logo.png', [180, 300]);

    const videoIds = [video_inicial, video_miraplay, ...videos_extras, video_inicial, video_final];
    const arquivosProntos = ['parte1_final.mp4'];

    for (let i = 0; i < videoIds.length; i++) {
      const idVideo = videoIds[i];
      if (!idVideo) continue;
      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}_720.mp4`;
      await baixarArquivo(idVideo, raw, auth);
      await reencode(raw, final);
      arquivosProntos.push(final);
    }

    arquivosProntos.push('parte2_final.mp4');

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
