const fs = require('fs');
const { spawn } = require('child_process');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const SCOPES = ['https://www.googleapis.com/auth/drive.readonly'];

function executarFFmpeg(args) {
  return new Promise((resolve, reject) => {
    console.log(`▶️ Executando FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'inherit' });
    proc.on('close', code => {
      if (code === 0) {
        console.log(`✅ FFmpeg finalizado com sucesso.`);
        resolve();
      } else {
        reject(new Error(`FFmpeg falhou com código ${code}`));
      }
    });
  });
}

async function autenticar() {
  console.log('🔑 Autenticando no Google Drive...');
  const auth = new google.auth.GoogleAuth({ keyFile, scopes: SCOPES });
  const client = await auth.getClient();
  console.log('🔑 Autenticação concluída.');
  return client;
}

async function baixarArquivo(fileId, destino, auth) {
  console.log(`⬇️ Baixando arquivo do Drive ID=${fileId} para ${destino}...`);
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });

  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destino);
    res.data.pipe(output);
    res.data.on('end', () => {
      console.log(`✅ Download concluído: ${destino}`);
      resolve();
    });
    res.data.on('error', err => {
      reject(err);
    });
  });
}

function obterDuracao(video) {
  return new Promise((resolve, reject) => {
    console.log(`⏱️ Obtendo duração do vídeo: ${video}...`);
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      video
    ]);
    let output = '';
    ffprobe.stdout.on('data', chunk => output += chunk.toString());
    ffprobe.on('close', code => {
      if (code === 0) {
        const duracao = parseFloat(output.trim());
        console.log(`⏱️ Duração obtida: ${duracao.toFixed(2)} segundos.`);
        resolve(duracao);
      } else {
        reject(new Error('❌ Falha ao obter duração com ffprobe'));
      }
    });
  });
}

async function cortarVideo(input, out1, out2, meio) {
  console.log(`✂️ Cortando vídeo ${input} em dois: ${out1} (0-${meio}s) e ${out2} (${meio}s-fim)...`);
  await executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  await executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
}

async function reencode(input, output) {
  console.log(`🔄 Reencodando vídeo ${input} para ${output} (1280x720, 30fps)...`);
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

async function gerarImagemTexto(texto) {
  const pathTxt = 'descricao.txt';
  console.log(`📝 Gerando imagem de texto para rodapé com conteúdo: "${texto}"`);
  fs.writeFileSync(pathTxt, texto);
  await executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'color=c=0x00000000:s=600x80',
    '-vf', `drawtext=textfile=${pathTxt}:fontcolor=white:fontsize=24:x=10:y=10`,
    '-frames:v', '1',
    'texto.png'
  ]);
  console.log('✅ Imagem de texto texto.png gerada.');
}

async function aplicarRodapeELogo(input, output, rodape, logo, delaySec = 360) {
  console.log(`🎨 Aplicando rodapé e logo no vídeo ${input}...`);

  // Corrigido o filtro para escapar vírgulas no if do colorchannelmixer
  const filter = `[0:v]format=rgba[base];` +
    `[1:v]scale=iw*0.15:-1[logo_scaled];` +
    `[2:v][3:v]hstack=inputs=2[rodape_completo];` +
    `[rodape_completo]format=rgba,colorchannelmixer=aa='if(lt(t\\,${delaySec})\\,0\\,if(lt(t\\,${delaySec + 5})\\,(t-${delaySec})/5\\,if(lt(t\\,${delaySec + 30})\\,1\\,if(lt(t\\,${delaySec + 35})\\,(${delaySec + 35}-t)/5\\,0))))'[footer_alpha];` +
    `[base][footer_alpha]overlay=x=0:y=main_h-overlay_h:format=auto[tmp1];` +
    `[tmp1][logo_scaled]overlay=W-w-10:10:format=auto`;

  await executarFFmpeg([
    '-i', input,
    '-i', logo,
    '-i', rodape,
    '-i', 'texto.png',
    '-filter_complex', filter,
    '-c:a', 'copy',
    output
  ]);

  console.log(`✅ Rodapé e logo aplicados e vídeo salvo como ${output}`);
}

async function unirVideos(lista, saida) {
  console.log(`🔗 Unindo vídeos na sequência para gerar ${saida}...`);
  const txt = 'list.txt';
  fs.writeFileSync(txt, lista.map(f => `file '${f}'`).join('\n'));
  await executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
  console.log(`✅ Vídeos unidos em ${saida}`);
}

(async () => {
  try {
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const videoPrincipal = dados.video_principal;
    const streamUrl = dados.stream_url;
    const liveId = dados.id;
    const logoId = dados.logo_id;
    const rodapeBase64 = dados.rodape_base64;
    const rodapeTexto = dados.rodape_texto;
    const videosExtras = dados.videos_extras || [];
    const videoInicialId = dados.video_inicial;
    const videoMiraplayId = dados.video_miraplay;
    const videoFinalId = dados.video_final;

    if (rodapeBase64) {
      console.log('🖼️ Salvando rodapé base64 em footer.png...');
      const base64Data = rodapeBase64.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync('footer.png', base64Data, { encoding: 'base64' });
      console.log('✅ Rodapé salvo em footer.png');
    }

    if (rodapeTexto) await gerarImagemTexto(rodapeTexto);
    if (logoId) await baixarArquivo(logoId, 'logo.png', auth);
    await baixarArquivo(videoPrincipal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    await cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    await reencode('parte1_raw.mp4', 'parte1_re.mp4');
    await reencode('parte2_raw.mp4', 'parte2_re.mp4');

    await aplicarRodapeELogo('parte1_re.mp4', 'parte1_final.mp4', 'footer.png', 'logo.png', 360);
    await aplicarRodapeELogo('parte2_re.mp4', 'parte2_final.mp4', 'footer.png', 'logo.png', 360);

    const arquivosProntos = ['parte1_final.mp4'];

    const videoIds = [
      videoInicialId,
      videoMiraplayId,
      ...videosExtras.slice(0, 5),
      videoInicialId,
      'parte2_final.mp4',
      videoFinalId
    ];

    for (let i = 0; i < videoIds.length; i++) {
      const id = videoIds[i];
      if (typeof id === 'string' && id.endsWith('.mp4') && fs.existsSync(id)) {
        console.log(`🔄 Vídeo local já existe: ${id}, adicionando direto na lista.`);
        arquivosProntos.push(id);
        continue;
      }

      if (!id) {
        console.log(`⚠️ ID de vídeo inválido ou vazio na posição ${i}, pulando.`);
        continue;
      }

      const raw = `video_${i}_raw.mp4`;
      const final = `video_${i}.mp4`;

      await baixarArquivo(id, raw, auth);
      await reencode(raw, final);
      arquivosProntos.push(final);
    }

    await unirVideos(arquivosProntos, 'video_final_completo.mp4');

    fs.writeFileSync('stream_info.json', JSON.stringify({
      stream_url: streamUrl,
      video_id: liveId
    }, null, 2));

    console.log('🎉 Todos os passos foram concluídos com sucesso!');
    console.log('🎬 Vídeo final criado: video_final_completo.mp4');
  } catch (err) {
    console.error('❌ Erro durante a execução:', err);
    process.exit(1);
  }
})();
