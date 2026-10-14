(function(){
  "use strict";
  // Lucide 0.468.0, https://github.com/lucide-icons/lucide/tree/0.468.0/icons
  var paths = {
    mic: ["<path d=\"M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z\"></path>", "<path d=\"M19 10v2a7 7 0 0 1-14 0v-2\"></path>", "<line x1=\"12\" x2=\"12\" y1=\"19\" y2=\"22\"></line>", "<line x1=\"8\" x2=\"16\" y1=\"22\" y2=\"22\"></line>"],
    camera: ["<path d=\"M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z\"></path>", "<circle cx=\"12\" cy=\"13\" r=\"3\"></circle>"],
    "book-open": ["<path d=\"M12 7v14\"></path>", "<path d=\"M3 3h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5v16h-5a4 4 0 0 0-4 2 4 4 0 0 0-4-2H3Z\"></path>"],
    "alert-triangle": ["<path d=\"m21.73 18-8-14a2 2 0 0 0-3.46 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3\"></path>", "<path d=\"M12 9v4\"></path>", "<path d=\"M12 17h.01\"></path>"],
    "message-circle": ["<path d=\"M7.9 20A9 9 0 1 0 4 16.1L2 22Z\"></path>"],
    sparkle: ["<path d=\"m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z\"></path>"],
    rainbow: ["<path d=\"M22 17a10 10 0 0 0-20 0\"></path>", "<path d=\"M6 17a6 6 0 0 1 12 0\"></path>", "<path d=\"M10 17a2 2 0 0 1 4 0\"></path>", "<path d=\"M2 17h20\"></path>"],
    star: ["<path d=\"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.1 2.1 0 0 0 1.58 1.15l5.166.751a.53.53 0 0 1 .294.904l-3.738 3.644a2.1 2.1 0 0 0-.604 1.858l.883 5.144a.53.53 0 0 1-.769.56l-4.62-2.43a2.1 2.1 0 0 0-1.958 0l-4.62 2.43a.53.53 0 0 1-.769-.56l.883-5.144a2.1 2.1 0 0 0-.604-1.858L2.13 9.779a.53.53 0 0 1 .294-.904l5.166-.751a2.1 2.1 0 0 0 1.58-1.15z\"></path>"],
    image: ["<rect width=\"18\" height=\"18\" x=\"3\" y=\"3\" rx=\"2\" ry=\"2\"></rect>", "<circle cx=\"9\" cy=\"9\" r=\"2\"></circle>", "<path d=\"m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21\"></path>"],
    search: ["<circle cx=\"11\" cy=\"11\" r=\"8\"></circle>", "<path d=\"m21 21-4.3-4.3\"></path>"],
    "volume-2": ["<path d=\"M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z\"></path>", "<path d=\"M16 9a5 5 0 0 1 0 6\"></path>", "<path d=\"M19.364 18.364a9 9 0 0 0 0-12.728\"></path>"],
    "arrow-left": ["<path d=\"m12 19-7-7 7-7\"></path>", "<path d=\"M19 12H5\"></path>"],
    x: ["<path d=\"M18 6 6 18\"></path>", "<path d=\"m6 6 12 12\"></path>"],
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
