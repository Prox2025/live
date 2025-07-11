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
    proc.on('close', code => code === 0 ? resolve() : reject(new Error(`🚨 ERRO: FFmpeg falhou (${code})`)));
  });
}

function registrarTemporario(arquivo) {
  arquivosTemporarios.push(arquivo);
}

function limparTemporarios() {
  console.log('🧹 Limpando arquivos temporários...');
  arquivosTemporarios.forEach(arquivo => {
    try {
      if (fs.existsSync(arquivo)) {
        fs.unlinkSync(arquivo);
        console.log(`🗑️ Removido: ${arquivo}`);
      }
    } catch (e) {
      console.warn(`⚠️ Falha ao remover ${arquivo}: ${e.message}`);
    }
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
      resolve();
    });
    res.data.on('error', reject);
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let data = '';
    ff.stdout.on('data', chunk => data += chunk.toString());
    ff.on('close', code => {
      if (code === 0) resolve(parseFloat(data.trim()));
      else reject(new Error('Erro ao obter duração'));
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

/**
 * Aplica o logo e o rodapé em um vídeo de entrada.
 * - Logo redimensionado para 15% da largura do vídeo (1280px).
 * - Fundo semi-transparente cinza claro (RGBA ~90% transparente) atrás do rodapé para substituir fundo preto.
 * - O rodapé aparece só durante sua duração (disable no final).
 *
 * @param {string} input Caminho do vídeo de entrada
 * @param {string} output Caminho do vídeo de saída
 * @param {string} logo Caminho da imagem do logo
 * @param {string} rodape Caminho do vídeo do rodapé (com transparência)
 * @param {number} duracaoRodape Duração do rodapé em segundos
 */
async function aplicarLogoRodape(input, output, logo, rodape, duracaoRodape) {
  // cor de fundo RGBA, cinza claro com alpha 0.1 (~90% transparente)
  // "0xC8C8C8" é o tom de cinza, @0.1 é transparência
  const filtro = [
    `[0:v]scale=1280:720:flags=lanczos,format=rgba[base]`,
    `[1:v]scale=iw*0.15:-1[logo]`, // logo 15% da largura do vídeo
    // Cria um retângulo de fundo translúcido da largura do vídeo e altura ~108px (15% de 720)
    `color=c=0xC8C8C8@0.1:s=1280x108:d=${duracaoRodape}[fundo]`,
    `[2:v]scale=1280:-1:flags=lanczos,format=rgba,setpts=PTS-STARTPTS[rodape]`,
    // Sobrepõe o fundo translúcido na base do vídeo
    `[base][fundo]overlay=x=0:y=H-108[base_fundo]`,
    // Sobrepõe o logo no canto superior direito com margens
    `[base_fundo][logo]overlay=W-w-11:11[tmp1]`,
    // Sobrepõe o rodapé no fundo+logo, habilitado só até a duração do rodapé
    `[tmp1][rodape]overlay=x=0:y=H-h:enable='lte(t,${duracaoRodape})'[outv]`
  ];

  const args = [
    '-i', input,
    '-i', logo,
    '-i', rodape,
    '-filter_complex', filtro.join(';'),
    '-map', '[outv]',
    '-map', '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-y', output
  ];

  await executarFFmpeg(args);
  registrarTemporario(output);
}

async function unirVideos(lista, saida) {
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(v => `file '${v}'`).join('\n'));
  registrarTemporario(txt);

  // Concatenar vídeos com cópia direta (sem re-encode)
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);

  console.log(`🎬 Vídeo final criado: ${saida}`);

  const stats = fs.statSync(saida);
  const tamanhoMB = (stats.size / (1024 * 1024)).toFixed(2);
  const duracaoFinal = await obterDuracao(saida);

  console.log(`⏱️ Duração final: ${duracaoFinal.toFixed(2)}s`);
  console.log(`📦 Tamanho final: ${tamanhoMB} MB`);
}

(async () => {
  try {
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const {
      id, video_principal, logo_id, rodape_id,
      video_inicial, video_miraplay, video_final,
      videos_extras = [], stream_url
    } = dados;

    const obrigatorios = { video_principal, logo_id, rodape_id, video_inicial, video_miraplay, video_final };
    const faltando = Object.entries(obrigatorios).filter(([_, v]) => !v);
    if (faltando.length)
      throw new Error('❌ input.json incompleto:\n' + faltando.map(([k]) => `- ${k}`).join('\n'));

    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(rodape_id, 'rodape.webm', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    const duracaoPrincipal = await obterDuracao('principal.mp4');
    const meio = duracaoPrincipal / 2;
    const duracaoRodape = await obterDuracao('rodape.webm');

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_720.mp4');
    await reencode('parte2_raw.mp4', 'parte2_720.mp4');

    await aplicarLogoRodape('parte1_720.mp4', 'parte1_final.mp4', 'logo.png', 'rodape.webm', duracaoRodape);
    await aplicarLogoRodape('parte2_720.mp4', 'parte2_final.mp4', 'logo.png', 'rodape.webm', duracaoRodape);

    const videoIds = [video_inicial, video_miraplay, ...videos_extras, video_inicial, video_final];
    const arquivos = ['parte1_final.mp4'];

    for (let i = 0; i < videoIds.length; i++) {
      const vid = videoIds[i];
      const nome = `video_extra_${i}`;
      await baixarArquivo(vid, `${nome}_raw.mp4`, auth);
      await reencode(`${nome}_raw.mp4`, `${nome}.mp4`);
      arquivos.push(`${nome}.mp4`);
    }

    arquivos.push('parte2_final.mp4');
    await unirVideos(arquivos, 'video_final_completo.mp4');

    if (stream_url && id) {
      fs.writeFileSync('stream_info.json', JSON.stringify({ stream_url, id, video_id: id }, null, 2));
      console.log('💾 stream_info.json criado.');
    }

    limparTemporarios();
  } catch (e) {
    console.error('🚨 ERRO:', e.message);
    limparTemporarios();
    process.exit(1);
  }
})();
