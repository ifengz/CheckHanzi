(function(){
  "use strict";
  // Lucide 0.468.0, https://github.com/lucide-icons/lucide/tree/0.468.0/icons
  var paths = {
    mic: ["<path d=\"M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z\"></path>", "<path d=\"M19 10v2a7 7 0 0 1-14 0v-2\"></path>", "<line x1=\"12\" x2=\"12\" y1=\"19\" y2=\"22\"></line>", "<line x1=\"8\" x2=\"16\" y1=\"22\" y2=\"22\"></line>"],
    search: ["<circle cx=\"11\" cy=\"11\" r=\"8\"></circle>", "<path d=\"m21 21-4.3-4.3\"></path>"],
    "volume-2": ["<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"></path>", "<path d=\"M16 9a5 5 0 0 1 0 6\"></path>", "<path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\"></path>"],
    "arrow-left": ["<path d=\"m12 19-7-7 7-7\"></path>", "<path d=\"M19 12H5\"></path>"],
    "rotate-ccw": ["<path d=\"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8\"></path>", "<path d=\"M3 3v5h5\"></path>"]
  };
  function icon(name){
    var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("width", "20"); svg.setAttribute("height", "20");
    svg.setAttribute("fill", "none"); svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2"); svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round"); svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = (paths[name] || []).join("");
    return svg;
  }
  window.LucideIcons = { icon:icon };
  document.querySelectorAll("[data-lucide]").forEach(function(host){
    var svg = icon(host.getAttribute("data-lucide"));
    host.textContent = "";
    host.appendChild(svg);
  });
})();
