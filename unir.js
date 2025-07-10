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
  const client = await auth.getClient();
  return client;
}

async function baixarArquivo(fileId, destino, auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      registrarTemporario(destino);
      resolve();
    });
    res.data.on('error', reject);
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
    '-vf', 'scale=1280:720',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

async function aplicarRodape(input, output, rodape, logo, duracao, nomeParte) {
  const tempos = [180, 300]; // Minuto 3 e 5
  const comandos = [];

  comandos.push(`[0:v]scale=1280:720[base];`);
  comandos.push(`[1:v]scale=1280:720[rod];`);
  comandos.push(`[2:v]scale=iw*0.1:-1,setpts=PTS-STARTPTS[logo];`);

  let anterior = 'base';
  tempos.forEach((start, i) => {
    const end = (start + duracao).toFixed(3);
    comandos.push(`[${anterior}][rod]overlay=0:H-h:enable='between(t,${start},${end})'[tmp${i}];`);
    anterior = `tmp${i}`;
  });

  comandos.push(`[${anterior}][logo]overlay=W-w-20:20[outv]`);

  await executarFFmpeg([
    '-i', input,
    '-i', rodape,
    '-i', logo,
    '-filter_complex', comandos.join(' '),
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-y',
    output
  ]);
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
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const obrigatorios = ['video_principal', 'logo_id', 'rodape_id', 'video_inicial', 'video_miraplay', 'video_final'];
    const faltando = obrigatorios.filter(k => !dados[k]);
    if (faltando.length) throw new Error('❌ input.json incompleto:\n' + faltando.map(f => `- ${f}`).join('\n'));

    const {
      video_principal, logo_id, rodape_id,
      video_inicial, video_miraplay, video_final,
      videos_extras = []
    } = dados;

    await baixarArquivo(rodape_id, 'rodape.mp4', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracaoPrincipal = await obterDuracao('principal.mp4');
    const meio = duracaoPrincipal / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_720.mp4');
    await reencode('parte2_raw.mp4', 'parte2_720.mp4');

    const rodapeDuracao = await obterDuracao('rodape.mp4');

    await aplicarRodape('parte1_720.mp4', 'parte1_final.mp4', 'rodape.mp4', 'logo.png', rodapeDuracao, 'parte1');
    await aplicarRodape('parte2_720.mp4', 'parte2_final.mp4', 'rodape.mp4', 'logo.png', rodapeDuracao, 'parte2');

    const ordemFinal = ['parte1_final.mp4'];
    const baixarEReencodar = async (id, nome) => {
      await baixarArquivo(id, `${nome}_raw.mp4`, auth);
      await reencode(`${nome}_raw.mp4`, `${nome}.mp4`);
      return `${nome}.mp4`;
    };

    ordemFinal.push(await baixarEReencodar(video_inicial, 'video_inicial_1'));
    ordemFinal.push(await baixarEReencodar(video_miraplay, 'video_miraplay'));

    for (let i = 0; i < videos_extras.length; i++) {
      if (videos_extras[i]) {
        ordemFinal.push(await baixarEReencodar(videos_extras[i], `extra${i}`));
      }
    }

    ordemFinal.push(await baixarEReencodar(video_inicial, 'video_inicial_2'));
    ordemFinal.push('parte2_final.mp4');
    ordemFinal.push(await baixarEReencodar(video_final, 'video_final'));

    await unirVideos(ordemFinal, 'video_final_completo.mp4');

    console.log('✅ Vídeo final salvo como video_final_completo.mp4');
    limparTemporarios();
  } catch (err) {
    console.error('🚨 ERRO:', err.message);
    limparTemporarios();
    process.exit(1);
  }
})();
