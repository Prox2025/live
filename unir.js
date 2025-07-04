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
    '-vf', 'scale=720:900,fps=30',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    output
  ]);
  registrarTemporario(output);
}

function gerarTemposAleatorios(duracao, quantidade) {
  const tempos = [];
  while (tempos.length < quantidade) {
    const t = Math.floor(Math.random() * (duracao - 50));
    if (!tempos.some(e => Math.abs(e - t) < 60)) tempos.push(t);
  }
  tempos.sort((a, b) => a - b);
  return tempos;
}

// Função que cria o vídeo do rodapé (rodapé com fundo degradê animado)
async function criarVideoRodape(rodapeImg, output, duracao) {
  const filtros = [
    `[0:v]scale=720:72,format=rgba,split=2[r0][r1]`,
    `color=black@1.0:size=720x72:d=${duracao},format=rgba,lut=a='if(lt(y\\,10)\\,255\\,if(lt(y\\,20)\\,200\\,if(lt(y\\,30)\\,150\\,if(lt(y\\,40)\\,100\\,if(lt(y\\,50)\\,60\\,if(lt(y\\,60)\\,30\\,0)))))))[bg]'`,
    `[r0][bg]overlay=format=auto[rodape]`
  ];

  const args = [
    '-loop', '1',
    '-i', rodapeImg,
    '-f', 'lavfi',
    '-t', duracao.toString(),
    '-filter_complex', filtros.join(';'),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuva420p',
    output
  ];

  await executarFFmpeg(args);
  registrarTemporario(output);
}

// Função que injeta o rodapé e o logo fixo nas partes principais
async function aplicarRodapeELogoComVideoRodape(input, output, videoRodape, logo, duracao) {
  const temposRodape = gerarTemposAleatorios(duracao, 2); // dois tempos aleatórios para o rodapé

  console.log(`🎞️ Aplicando rodapé nos tempos:`, temposRodape);

  const filtros = [];
  let videoBase = '[0:v]';

  temposRodape.forEach((inicio, i) => {
    const fim = inicio + 40;
    filtros.push(
      `${videoBase}[1:v]trim=start=${inicio}:duration=40,setpts=PTS-STARTPTS[rodape_trim${i}]`,
      `[rodape_trim${i}]overlay=0:H-72:enable='between(t,${inicio},${fim})'[tmp${i}]`
    );
    videoBase = `[tmp${i}]`;
  });

  filtros.push(`[2:v]scale=150:-1[logo]`);
  filtros.push(`${videoBase}[logo]overlay=W-w-10:10[final]`); // logo sempre visível

  const args = [
    '-i', input,
    '-i', videoRodape,
    '-i', logo,
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

    // Baixar arquivos necessários
    await baixarArquivo(rodape_id, 'footer.png', auth);
    await baixarArquivo(logo_id, 'logo.png', auth);
    await baixarArquivo(video_principal, 'principal.mp4', auth);

    // Obter duração do vídeo principal
    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    // Cortar vídeo em 2 partes
    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);

    // Reencode para padrão
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    // Criar vídeo do rodapé (com duração igual ao vídeo principal dividido)
    // Aqui criamos um rodapé com duração suficiente para o vídeo inteiro (ou pelo menos a parte)
    // Para simplicidade, criamos rodapé para duração do vídeo 1 e 2
    await criarVideoRodape('footer.png', 'rodape_video.mp4', 40); // rodapé com 40 segundos (duração fixa para sobreposição)

    // Aplica rodapé + logo fixo nas partes principais (1 e 2)
    await aplicarRodapeELogoComVideoRodape('parte1_re.mp4', 'parte1_final.mp4', 'rodape_video.mp4', 'logo.png', meio);
    await aplicarRodapeELogoComVideoRodape('parte2_re.mp4', 'parte2_final.mp4', 'rodape_video.mp4', 'logo.png', duracao - meio);

    // Baixar e preparar vídeos extras
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

    // Unir todos os vídeos em sequência
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
