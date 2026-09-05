(function(){
  "use strict";

  var WORD_RE = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;

  function node(tag, className, text){
    var el = document.createElement(tag);
    if(className) el.className = className;
    if(text !== undefined) el.textContent = text;
    return el;
  }

  function buttonWithIcon(config, className, iconName, label, ariaLabel){
    var button = node("button", className);
    button.type = "button";
    var glyph = config.icon ? config.icon(iconName) : null;
    if(glyph) button.appendChild(glyph);
    button.appendChild(node("span", "english-button-label", label));
    button.setAttribute("aria-label", ariaLabel || label);
    button.title = ariaLabel || label;
    return button;
  }

  function partOfSpeechLabel(value){
    var labels = {"n.":"名词", "v.":"动词", "pron.":"代词", "art.":"冠词"};
    return labels[value] || value;
  }

  function utf8Bytes(text){
    if(window.TextEncoder) return new TextEncoder().encode(text).length;
    return unescape(encodeURIComponent(text)).length;
  }

  function createEnglishLookup(config){
    var root = config.root;
    var toggle = config.toggle;
    var state = { seq:0, controller:null, timeoutId:null, lastQuery:"", sentence:null, wordFromSentence:false };
    var status = node("div", "english-status");
    status.setAttribute("role", "status");
    var resultBox = node("div", "english-result");
    root.innerHTML = "";
    root.appendChild(status);
    root.appendChild(resultBox);

    function abortPending(){
      state.seq++;
      if(state.controller) state.controller.abort();
      if(state.timeoutId) clearTimeout(state.timeoutId);
      state.controller = null; state.timeoutId = null;
    }

    function clear(){
      abortPending();
      config.cancelSpeech();
      state.lastQuery = "";
      state.sentence = null;
      state.wordFromSentence = false;
      status.textContent = "";
      resultBox.textContent = "";
    }

    function sourceLine(source){
      if(!source || typeof source.name !== "string") return null;
      var row = node("div", "english-source");
      row.appendChild(document.createTextNode("来源："));
      var label = node("span", "english-source-name", source.name);
      row.appendChild(label);
      if(typeof source.url === "string"){
        try{
          var url = new URL(source.url, location.href);
          if(url.protocol === "https:"){
            var link = node("a", "english-source-link", "查看");
            link.href = url.href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.setAttribute("aria-label", source.name);
            row.appendChild(link);
          }
        }catch(error){}
      }
      return row;
    }

    function speakButton(text){
      var button = buttonWithIcon(config, "english-speak", "volume-2", "朗读", "朗读 " + text);
      button.addEventListener("click", function(){ config.speak(text, button, "en"); });
      return button;
    }

    function backButton(){
      var button = buttonWithIcon(config, "english-back", "arrow-left", "返回原句", "返回原句");
      button.addEventListener("click", function(){
        if(state.sentence){
          abortPending();
          config.cancelSpeech();
          state.lastQuery = state.sentence.text;
          state.wordFromSentence = false;
          renderSentence(state.sentence.result, state.sentence.text);
        }
      });
      return button;
    }

    function renderWord(result, fromSentence){
      resultBox.textContent = "";
      var head = node("div", "english-result-head");
      head.appendChild(node("span", "english-kind", "单词"));
      head.appendChild(speakButton(result.word));
      if(fromSentence) head.appendChild(backButton());
      resultBox.appendChild(head);
      resultBox.appendChild(node("div", "english-word", result.word));
      if(typeof result.phonetic === "string" && result.phonetic){
        resultBox.appendChild(node("div", "english-phonetic", result.phonetic));
      }
      var meanings = Array.isArray(result.meanings) ? result.meanings : [];
      var list = node("div", "english-meanings");
      function addMeaning(parent, meaning, primary){
        var row = node("div", "english-meaning");
        if(primary) row.classList.add("english-meaning-primary");
        if(meaning && typeof meaning.partOfSpeech === "string" && meaning.partOfSpeech){
          row.appendChild(node("span", "english-pos", partOfSpeechLabel(meaning.partOfSpeech)));
        }
        if(meaning && typeof meaning.translation === "string"){
          row.appendChild(node("span", "english-translation", meaning.translation));
        }
        parent.appendChild(row);
      }
      if(meanings.length) addMeaning(list, meanings[0], true);
      if(meanings.length > 1){
        var more = document.createElement("details");
        more.className = "english-more";
        more.appendChild(node("summary", "english-more-summary", "更多释义"));
        meanings.slice(1).forEach(function(meaning){ addMeaning(more, meaning, false); });
        list.appendChild(more);
      }
      resultBox.appendChild(list);
      var source = sourceLine(result.source);
      if(source) resultBox.appendChild(source);
    }

    function sentenceTokens(text){
      var fragment = document.createDocumentFragment();
      var last = 0; var match;
      WORD_RE.lastIndex = 0;
      while((match = WORD_RE.exec(text))){
        if(match.index > last) fragment.appendChild(document.createTextNode(text.slice(last, match.index)));
        (function(word){
          var button = node("button", "english-token", word);
          button.type = "button";
          button.setAttribute("aria-label", "查询 " + word);
          button.addEventListener("click", function(){
            lookup(word, true);
          });
          fragment.appendChild(button);
        })(match[0]);
        last = match.index + match[0].length;
      }
      if(last < text.length) fragment.appendChild(document.createTextNode(text.slice(last)));
      return fragment;
    }

    function renderSentence(result, text){
      state.sentence = {result:result, text:text};
      state.wordFromSentence = false;
      resultBox.textContent = "";
      var head = node("div", "english-result-head");
      head.appendChild(node("span", "english-kind", "句子"));
      head.appendChild(speakButton(text));
      resultBox.appendChild(head);
      var original = node("div", "english-sentence");
      original.appendChild(sentenceTokens(text));
      resultBox.appendChild(original);
      resultBox.appendChild(node("div", "english-translation", result.translation || ""));
      var source = sourceLine(result.source);
      if(source) resultBox.appendChild(source);
    }

    function renderError(message){
      resultBox.textContent = "";
      var row = node("div", "english-error");
      row.appendChild(node("span", "english-error-message", message || "查询失败"));
      var retry = buttonWithIcon(config, "english-retry", "rotate-ccw", "重试", "重试");
      retry.addEventListener("click", function(){ lookup(state.lastQuery, state.wordFromSentence); });
      row.appendChild(retry);
      if(state.sentence && state.wordFromSentence) row.appendChild(backButton());
      resultBox.appendChild(row);
    }

    function renderResult(result, query, fromSentence){
      if(!result || (result.kind !== "word" && result.kind !== "sentence")){
        renderError("查询结果格式不正确");
        return;
      }
      if(result.kind === "word"){
        config.prefetchTTS(result.word, "en").catch(function(){});
        renderWord(result, fromSentence);
        return;
      }
      config.prefetchTTS(query, "en").catch(function(){});
      renderSentence(result, query);
    }

    function lookup(query, fromSentence){
      if(typeof query !== "string" || !query.trim()) return;
      abortPending();
      config.cancelSpeech();
      if(!fromSentence){ state.sentence = null; state.wordFromSentence = false; }
      if(Array.from(query).length > 300 || utf8Bytes(query) > 500){
        state.lastQuery = query;
        state.wordFromSentence = !!fromSentence;
        status.textContent = "";
        renderError("内容太长了");
        return;
      }
      var seq = ++state.seq;
      var controller = new AbortController();
      state.controller = controller;
      state.lastQuery = query;
      state.wordFromSentence = !!fromSentence;
      root.hidden = false;
      status.textContent = "正在查询…";
      resultBox.textContent = "";
      var timedOut = false;
      var timeoutId = setTimeout(function(){ timedOut = true; controller.abort(); }, 12000);
      state.timeoutId = timeoutId;
      fetch("/api/english", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({text:query}),
        signal:controller.signal
      }).then(function(response){
        return response.json().catch(function(){ return null; }).then(function(body){
          if(!response.ok){
            var error = body && body.error;
            throw new Error(error && typeof error.message === "string" ? error.message : "查询失败（HTTP " + response.status + "）");
          }
          return body;
        });
      }).then(function(result){
        if(seq !== state.seq || lookupLanguageIsEnglish() === false) return;
        clearTimeout(timeoutId);
        if(state.controller === controller){ state.controller = null; state.timeoutId = null; }
        status.textContent = "";
        renderResult(result, query, !!fromSentence);
      }).catch(function(error){
        if(seq !== state.seq || (error.name === "AbortError" && !timedOut)) return;
        clearTimeout(timeoutId);
        if(state.controller === controller){ state.controller = null; state.timeoutId = null; }
        status.textContent = "";
        renderError(timedOut ? "查询超时，请重试" : (error.name === "TypeError" ? "网络连接失败，请重试" : (error.message || "查询失败，请重试")));
      });
    }

    function lookupLanguageIsEnglish(){ return config.isEnglish ? config.isEnglish() : true; }

    function setLanguage(language){
      var isEnglish = language === "en";
      toggle.querySelectorAll("[data-language]").forEach(function(button){
        var selected = button.getAttribute("data-language") === language;
        button.setAttribute("aria-selected", selected ? "true" : "false");
      });
      root.hidden = !isEnglish;
      if(!isEnglish) clear();
      config.onLanguageChange(language);
    }

    toggle.querySelectorAll("[data-language]").forEach(function(button){
      button.addEventListener("click", function(){ setLanguage(button.getAttribute("data-language")); });
    });
    root.hidden = true;
    return { lookup:lookup, clear:clear, handleRecognition:function(text){
      lookup(text, false);
    }, setLanguage:setLanguage };
  }

  window.dispatchEvent(new CustomEvent("english-lookup-ready", {detail:{create:createEnglishLookup}}));
})();
