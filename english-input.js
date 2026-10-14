(function(){
  "use strict";

  function wordsFromText(text){
    if(typeof text !== "string") throw new Error("识别结果格式不正确，请重拍");
    var matches = text.normalize("NFKC").match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g) || [];
    var seen = new Set();
    return matches.filter(function(word){
      var key = word.toLowerCase().replace(/’/g, "'");
      if(seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  function learningForWord(word, data){
    if(typeof word !== "string" || !data) return null;
    var key = word.toLowerCase();
    if(!Object.prototype.hasOwnProperty.call(data, key)) return null;
    var entry = data[key];
    if(!entry || ![entry.meaning, entry.example, entry.translation].every(function(value){ return typeof value === "string" && !!value.trim(); })) return null;
    return entry;
  }

  var learningPromise = null;
  function loadLearning(){
    if(!learningPromise){
      learningPromise = fetch("data/english-learning.json?v=1").then(function(response){
        if(!response.ok) throw new Error("例句暂时加载不了，请重试");
        return response.json();
      }).then(function(data){
        if(!data || typeof data !== "object" || Array.isArray(data)) throw new Error("例句数据格式不正确");
        return data;
      }).catch(function(error){ learningPromise = null; throw error; });
    }
    return learningPromise;
  }

  var libraryPromise = null;
  function loadOCR(){
    if(window.Tesseract) return Promise.resolve(window.Tesseract);
    if(!libraryPromise){
      libraryPromise = new Promise(function(resolve, reject){
        var script = document.createElement("script");
        script.src = "models/ocr/tesseract.min.js";
        script.onload = function(){
          if(window.Tesseract) resolve(window.Tesseract);
          else reject(new Error("拍照识别加载失败，请重试"));
        };
        script.onerror = function(){ script.remove(); reject(new Error("拍照识别加载失败，请检查网络")); };
        document.head.appendChild(script);
      }).catch(function(error){ libraryPromise = null; throw error; });
    }
    return libraryPromise;
  }

  function element(tag, className, text){
    var node = document.createElement(tag);
    if(className) node.className = className;
    if(text !== undefined) node.textContent = text;
    return node;
  }

  function mount(config){
    var jobSeq = 0, worker = null, imageURL = null, timer = null;
    var panel = element("section", "english-input-panel");
    panel.setAttribute("aria-label", "从课本找英文");
    var head = element("div", "english-input-head");
    head.appendChild(element("h2", "english-input-title", "从课本找英文"));
    function button(label, iconName, className){
      var result = element("button", "english-input-button " + (className || ""));
      result.type = "button";
      if(config.icon){ var icon = config.icon(iconName); if(icon) result.appendChild(icon); }
      result.appendChild(element("span", "english-button-label", label));
      return result;
    }
    var change = button("换个单词", "search", "english-input-change"); change.hidden = true;
    head.appendChild(change); panel.appendChild(head);
    panel.appendChild(element("p", "english-input-help", "拍清楚课本上的英文，再点不会读的词。"));
    var actions = element("div", "english-photo-actions");
    var camera = button("拍课本", "camera", "english-camera");
    var album = button("选照片", "image", "english-album");
    actions.appendChild(camera); actions.appendChild(album); panel.appendChild(actions);
    function fileInput(capture){
      var input = element("input"); input.type = "file"; input.accept = "image/*"; input.hidden = true;
      if(capture) input.setAttribute("capture", "environment");
      input.id = capture ? "englishCameraFile" : "englishAlbumFile";
      panel.appendChild(input);
      input.addEventListener("change", function(){
        var file = input.files && input.files[0];
        input.value = "";
        if(file) recognize(file);
      });
      return input;
    }
    var cameraFile = fileInput(true), albumFile = fileInput(false);
    var photoStatus = element("p", "english-photo-status");
    photoStatus.setAttribute("role", "status"); photoStatus.setAttribute("aria-live", "polite"); panel.appendChild(photoStatus);
    var cancel = button("取消识别", "x", "english-photo-cancel"); cancel.hidden = true; panel.appendChild(cancel);
    var photo = element("div", "english-photo-preview"); photo.hidden = true;
    var image = element("img"); image.alt = "刚选的课本照片"; photo.appendChild(image); panel.appendChild(photo);
    var candidates = element("div", "english-photo-words");
    candidates.setAttribute("aria-label", "照片里的单词"); panel.appendChild(candidates);
    var form = element("form", "english-input-form");
    var label = element("label", "english-input-label", "也可以输入或粘贴单词"); label.htmlFor = "englishWordInput";
    form.appendChild(label);
    var fieldRow = element("div", "english-input-field");
    var input = element("input", "english-word-input"); input.type = "text"; input.id = "englishWordInput";
    input.placeholder = "输入英文单词"; input.maxLength = 300; input.autocomplete = "off"; input.spellcheck = false;
    input.setAttribute("autocapitalize", "none"); input.setAttribute("enterkeyhint", "search");
    fieldRow.appendChild(input);
    var submit = button("查单词", "search", "english-submit"); submit.type = "submit";
    fieldRow.appendChild(submit); form.appendChild(fieldRow); panel.appendChild(form);
    config.root.insertBefore(panel, config.root.firstChild);

    function setBusy(busy){
      cancel.hidden = !busy;
      panel.setAttribute("aria-busy", busy ? "true" : "false");
    }
    function cancelPending(){
      jobSeq++;
      if(timer) clearTimeout(timer); timer = null;
      if(worker){ worker.terminate().catch(function(){}); worker = null; }
      setBusy(false);
    }
    function clearPhoto(){
      if(imageURL) URL.revokeObjectURL(imageURL); imageURL = null;
      image.removeAttribute("src"); photo.hidden = true; candidates.textContent = "";
    }
    function chooseWord(word, trigger){
      config.cancelRecognition();
      input.value = word;
      candidates.querySelectorAll("button").forEach(function(node){ node.setAttribute("aria-pressed", node === trigger ? "true" : "false"); });
      panel.classList.add("compact"); change.hidden = false;
      config.root.scrollTop = 0;
      config.controller.lookup(word, false, false, false);
    }
    async function recognize(file){
      config.cancelRecognition();
      cancelPending(); clearPhoto(); config.controller.clear();
      photoStatus.textContent = "";
      if(!file.type.startsWith("image/")){ photoStatus.textContent = "请选择一张照片"; return; }
      if(file.size > 20 * 1024 * 1024){ photoStatus.textContent = "照片太大，请拍近一点或换一张照片"; return; }
      var seq = ++jobSeq; setBusy(true);
      photoStatus.textContent = "正在准备照片…";
      timer = setTimeout(function(){
        if(seq !== jobSeq) return;
        cancelPending(); photoStatus.textContent = "识别时间太长，请重拍或输入单词";
      }, 60000);
      try{
        imageURL = URL.createObjectURL(file); image.src = imageURL; photo.hidden = false;
        await image.decode();
        if(seq !== jobSeq) return;
        if(!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 50000000){ throw new Error("照片尺寸太大，请换一张照片"); }
        var canvas = document.createElement("canvas");
        var scale = Math.min(1, 2200 / Math.max(image.naturalWidth, image.naturalHeight));
        canvas.width = Math.round(image.naturalWidth * scale); canvas.height = Math.round(image.naturalHeight * scale);
        var ctx = canvas.getContext("2d");
        if(!ctx) throw new Error("这张照片暂时打不开，请换一张");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        photoStatus.textContent = "正在准备英文识别，第一次需要稍等…";
        var Tesseract = await loadOCR();
        if(seq !== jobSeq) return;
        var activeWorker = await Tesseract.createWorker("eng", 1, {
          workerPath: new URL("models/ocr/worker.min.js", location.href).href,
          corePath: new URL("models/ocr/", location.href).href,
          langPath: new URL("models/ocr/", location.href).href.replace(/\/$/, ""),
          workerBlobURL: false,
          logger: function(message){
            if(seq !== jobSeq) return;
            if(message.status === "recognizing text") photoStatus.textContent = "正在找单词… " + Math.round(message.progress * 100) + "%";
          }
        });
        if(seq !== jobSeq){ await activeWorker.terminate(); return; }
        worker = activeWorker;
        await worker.setParameters({ tessedit_pageseg_mode: "11" });
        var result = await worker.recognize(canvas);
        if(seq !== jobSeq) return;
        var words = wordsFromText(result && result.data && result.data.text);
        if(timer) clearTimeout(timer); timer = null;
        worker = null; await activeWorker.terminate();
        if(seq !== jobSeq) return;
        setBusy(false);
        if(!words.length){ photoStatus.textContent = "没找到英文。把单词拍大、拍清楚，再试一次。"; return; }
        words.forEach(function(word){
          var candidate = element("button", "english-photo-word", word); candidate.type = "button";
          candidate.setAttribute("aria-label", "查询英文 " + word); candidate.setAttribute("aria-pressed", "false");
          candidate.addEventListener("click", function(){ chooseWord(word, candidate); }); candidates.appendChild(candidate);
        });
        photoStatus.textContent = "找到 " + words.length + " 个词，点一下不会读的词。认错了也可以在下面改。";
      }catch(error){
        if(seq !== jobSeq) return;
        cancelPending();
        photoStatus.textContent = error.message && /照片|识别|网络/.test(error.message) ? error.message : "这张照片暂时识别不了，请重拍或输入单词";
      }
    }
    camera.addEventListener("click", function(){ cameraFile.click(); });
    album.addEventListener("click", function(){ albumFile.click(); });
    cancel.addEventListener("click", function(){ cancelPending(); photoStatus.textContent = "已取消。可以重新拍照或输入单词。"; });
    form.addEventListener("submit", function(event){
      event.preventDefault();
      var word = input.value.trim();
      if(!word){ photoStatus.textContent = "先输入一个英文单词"; input.focus(); return; }
      if(!/^[A-Za-z]+(?:['’-][A-Za-z]+)*[.!?]?$/.test(word)){ photoStatus.textContent = "这里每次查一个英文单词"; return; }
      cancelPending(); photoStatus.textContent = ""; chooseWord(word);
    });
    function expand(){ panel.classList.remove("compact"); change.hidden = true; config.root.scrollTop = 0; }
    change.addEventListener("click", expand);
    config.homeButton.addEventListener("click", function(){ expand(); config.controller.setLanguage("en"); });
    function returnToChinese(){ cancelPending(); clearPhoto(); photoStatus.textContent = ""; config.controller.setLanguage("zh"); }
    window.addEventListener("pagehide", function(){ cancelPending(); clearPhoto(); });
    document.addEventListener("visibilitychange", function(){ if(document.hidden){ cancelPending(); photoStatus.textContent = ""; } });
    return { cancelPending: cancelPending, returnToChinese: returnToChinese };
  }

  window.EnglishInput = { wordsFromText: wordsFromText, learningForWord: learningForWord, loadLearning: loadLearning, mount: mount };
})();
