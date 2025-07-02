
const fs = require('fs');
const { spawn } = require('processo_filho');
const { google } = require('googleapis');

const keyFile = process.env.KEYFILE || 'chave.json';
const inputFile = process.env.INPUTFILE || 'input.json';
const ESCOPOS = ['https://www.googleapis.com/auth/drive.readonly'];

função executarFFmpeg(args) {
  retornar nova Promessa((resolver, rejeitar) => {
    console.log(`â–¶ï¸ Executando FFmpeg: ffmpeg ${args.join(' ')}`);
    const proc = spawn('ffmpeg', args, { stdio: 'herdar' });
    proc.on('fechar', código => {
      se (código === 0) {
        console.log(`âœ… FFmpeg finalizado com sucesso.`);
        resolver();
      } outro {
        rejeitar(new Error(`FFmpeg falhou com código ${code}`));
      }
    });
  });
}

função assíncrona autenticar() {
  console.log('ðŸ”' Autenticando no Google Drive...');
  const auth = novo google.auth.GoogleAuth({ keyFile, escopos: ESCOPES });
  const cliente = aguarde auth.getClient();
  console.log('ðŸ”' Autenticação concluída.');
  cliente de retorno;
}

função assíncrona baixarArquivo(fileId, destino, auth) {
  console.log(`â¬‡ï¸ Baixando arquivo do Drive ID=${fileId} para ${destino}...`);
  const drive = google.drive({ versão: 'v3', auth });
  const res = await drive.files.get({ fileId, alt: 'mídia' }, { responseType: 'stream' });

  retornar nova Promessa((resolver, rejeitar) => {
    const saída = fs.createWriteStream(destino);
    res.data.pipe(saída);
    res.data.on('fim', () => {
      console.log(`âœ… Download concluído: ${destino}`);
      resolver();
    });
    res.data.on('erro', err => {
      rejeitar(errar);
    });
  });
}

função obterDuracao(video) {
  retornar nova Promessa((resolver, rejeitar) => {
    console.log(`â ±ï¸ Obtendo duração do vídeo: ${video}...`);
    const ffprobe = spawn('ffprobe', [
      '-v', 'erro',
      '-show_entries', 'format=duração',
      '-de', 'padrão=noprint_wrappers=1:nokey=1',
      vídeo
    ]);
    deixe saída = '';
    ffprobe.stdout.on('dados', chunk => saída += chunk.toString());
    ffprobe.on('fechar', código => {
      se (código === 0) {
        const duracao = parseFloat(output.trim());
        console.log(`â ±ï¸ Duração obtida: ${duracao.toFixed(2)} segundos.`);
        resolve(duracao);
      } outro {
        rejeitar(new Error('â Œ Falha ao obter duração com ffprobe'));
      }
    });
  });
}

função assíncrona cortarVideo(input, out1, out2, meio) {
  console.log(`âœ‚ï¸ Cortando vídeo ${input} em dois: ${out1} (0-${meio}s) e ${out2} (${meio}s-fim)...`);
  aguardar executarFFmpeg(['-i', input, '-t', meio.toString(), '-c', 'copy', out1]);
  aguardar executarFFmpeg(['-i', input, '-ss', meio.toString(), '-c', 'copy', out2]);
}

função assíncrona reencodificar(entrada, saída) {
  console.log(`ðŸ”„ Reencodificando vídeo ${input} para ${output} (1280x720, 30fps)...`);
  aguardar executarFFmpeg([
    '-i', entrada,
    '-vf', 'escala=1280:720,fps=30',
    '-c:v', 'libx264',
    '-predefinido', 'muito rápido',
    '-crf', '23',
    '-c:a', 'aac',
    saída
  ]);
}

função assíncrona gerarImagemTexto(texto) {
  const pathTxt = 'descricao.txt';
  console.log(`ðŸ“ Gerando imagem de texto para rodapé com conteúdo: "${texto}"`);
  fs.writeFileSync(pathTxt, texto);
  aguardar executarFFmpeg([
    '-f', 'lavfi',
    '-i', 'cor=c=0x00000000:s=600x80',
    '-vf', `drawtext=textfile=${pathTxt}:fontcolor=white:fontsize=24:x=10:y=10`,
    '-quadros:v', '1',
    'texto.png'
  ]);
  console.log('âœ… Imagem de texto texto.png gerado.');
}

função assíncrona aplicarRodapeELogo(entrada, saída, rodape, logotipo, delaySec = 360) {
  console.log(`ðŸŽ¨ Aplicando rodapé e logo no vídeo ${input}...`);

  filtro const = `
    [0:v]formato=rgba[base];
    [1:v]escala=iw*0,15:-1[logo_scaled];
    [2:v][3:v]hstack=entradas=2[rodape_completo];
    [rodape_completo]formato=rgba,
      colorchannelmixer=aa='if(lt(t,${delaySec}),0,
      se(lt(t,${atrasoSeg + 5}),(t-${atrasoSeg})/5,
      se(lt(t,${delaySec + 30}),1,
      se(lt(t,${delaySec + 35}),(${delaySec + 35}-t)/5,0))))'[footer_alpha];
    [base][rodapé_alfa]sobreposição=x=0:y=main_h-overlay_h:formato=auto[tmp1];
    [tmp1][logo_scaled]overlay=Ww-10:10:formato=automático
  `;

  aguardar executarFFmpeg([
    '-i', entrada,
    '-i', logotipo,
    '-i', rodape,
    '-i', 'texto.png',
    '-filter_complex', filtro,
    '-c:a', 'copiar',
    saída
  ]);

  console.log(`âœ… Rodapé e logo aplicados e vídeo salvo como ${output}`);
}

função assíncrona unirVideos(lista, saida) {
  console.log(`ðŸ”— Unindo vídeos na sequência para gerar ${saida}...`);
  const txt = 'lista.txt';
  fs.writeFileSync(txt, lista.map(f => `arquivo '${f}'`).join('\n'));
  aguardar executarFFmpeg(['-f', 'concat', '-safe', '0', '-i', txt, '-c', 'copy', saida]);
  console.log(`âœ… Vídeos unidos em ${saida}`);
}

(assíncrono () => {
  tentar {
    const auth = await autenticar();
    const dados = JSON.parse(fs.readFileSync(inputFile));

    const videoPrincipal = dados.video_principal;
    const streamUrl = dados.stream_url;
    const liveId = dados.id;
    const logoId = dados.logo_id;
    const rodapeBase64 = dados.rodape_base64;
    const rodapeTexto = dados.rodape_texto;
    const vídeosExtras = dados.videos_extras || [];
    const videoInicialId = dados.video_inicial;
    const videoMiraplayId = dados.video_miraplay;
    const videoFinalId = dados.video_final;

    se (rodapeBase64) {
      console.log('ðŸ–¼ï¸ Salvando rodapé base64 em footer.png...');
      const base64Data = rodapeBase64.replace(/^data:image\/png;base64,/, '');
      fs.writeFileSync('footer.png', base64Data, { codificação: 'base64' });
      console.log('âœ… Rodapé salvo em footer.png');
    }

    if (rodapeTexto) aguardar gerarImagemTexto(rodapeTexto);
    se (logoId) aguardar baixarArquivo(logoId, 'logo.png', auth);
    aguardar baixarArquivo(videoPrincipal, 'principal.mp4', auth);

    const duracao = await obterDuracao('principal.mp4');
    const meio = duracao / 2;

    aguarde cortarVideo('principal.mp4', 'parte1_raw.mp4', 'parte2_raw.mp4', meio);
    aguarde reencode('parte1_raw.mp4', 'parte1_re.mp4');
    aguarde reencode('parte2_raw.mp4', 'parte2_re.mp4');

    aguardar aplicarRodapeELogo('parte1_re.mp4', 'parte1_final.mp4', 'footer.png', 'logo.png', 360);
    aguardar aplicarRodapeELogo('parte2_re.mp4', 'parte2_final.mp4', 'footer.png', 'logo.png', 360);

    const arquivosProntos = ['parte1_final.mp4'];

    const videoIds = [
      IDInicial do vídeo,
      videoMiraplayId,
      ...vídeosExtras.slice(0, 5),
      'parte2_final.mp4',
      IDFinal do vídeo
    ];

    para (deixe i = 0; i < videoIds.length; i++) {
      const id = videoIds[i];
      se (tipo de id === 'string' && id.endsWith('.mp4') && fs.existsSync(id)) {
        console.log(`ðŸ”„ Vídeo local já existe: ${id}, adicionando direto na lista.`);
        arquivosProntos.push(id);
        continuar;
      }

      se (!id) {
        console.log(`âš ï¸ ID do vídeo inválido ou vazio na posição ${i}, pulando.`);
        continuar;
      }

      const raw = `video_${i}_raw.mp4`;
      const final = `vídeo_${i}.mp4`;

      aguardar baixarArquivo(id, raw, auth);
      aguardar reencodificação(bruto, final);
      arquivosProntos.push(final);
    }

    aguardar unirVideos(arquivosProntos, 'video_final_completo.mp4');

    fs.writeFileSync('stream_info.json', JSON.stringify({
      stream_url: URL do fluxo,
      video_id: liveId
    }, nulo, 2));

    console.log('ðŸŽ‰ Todos os passos foram concluídos com sucesso!');
    console.log('ðŸŽ¬ Vídeo final criado: video_final_completo.mp4');
  } pegar (errar) {
    console.error('â Œ Erro durante a execução:', err);
    processo.exit(1);
  }
})();
