/* Shrinks the header once the .page area has been scrolled down a bit. */
(function () {
    var page = document.querySelector(".page");
    var header = document.getElementById("myHeader");
    if (!page || !header) return;

    function update() {
        var y = page.scrollTop;
        if (y > 60) header.classList.add("compact");
        else if (y < 10) header.classList.remove("compact");   // gap between the two values stops flicker
    }

    page.addEventListener("scroll", update, { passive: true });
    update();

    // lets arrow keys, space and page up/down scroll the area right away
    page.tabIndex = -1;
    page.focus({ preventScroll: true });

    function setScrollbarWidth() {
        document.documentElement.style.setProperty("--sbw", (page.offsetWidth - page.clientWidth) + "px");
    }
    setScrollbarWidth();
    addEventListener("resize", setScrollbarWidth);

    // the bar appears or disappears when the content height changes (images loading and so on)
    if ("ResizeObserver" in window) {
        var ro = new ResizeObserver(setScrollbarWidth);
        ro.observe(page);
        Array.prototype.forEach.call(page.children, function (c) { ro.observe(c); });
    }
})();

var projects = [
    { href: "/work/prod3.html",   name: "Production 3",         desc: "Technical Directing in Practice",          img: "/banners/Prod3_banner.png" },
    { href: "/work/excited.html", name: "ExcITEd Workshops",    desc: "Being a teacher assistant and a team lead", img: "/banners/excited_banner.png" },
    { href: "/work/3Dspace.html", name: "3D Space",             desc: "Creating a 3D modeling educational game",   img: "/banners/3DSpace_banner.png" },
    { href: "/work/prod2.html",   name: "Production 2",         desc: "Face It, HAVET, DACCHIE",                  img: "/banners/Prod2_banner.png" },
    { href: "/work/prod1.html",   name: "Production 1",         desc: "My first 3D animation short",              img: "/banners/Prod1_banner.png" },
    { href: "/work/pb4p.html",    name: "Pencils Before Pixels", desc: "Drawing Workshops in VR",                 img: "/banners/PB4P_banner.png" }
];

var list = document.querySelector(".more-list");
if (list) {
    list.innerHTML = projects
        .filter(function (p) { return p.href !== location.pathname; })   // leave out the current page
        .map(function (p) {
            return '<li><a href="' + p.href + '"><img class="thumb" src="' + p.img +
                   '" alt="" loading="lazy"><span class="name">' + p.name +
                   '</span><span class="desc">' + p.desc + '</span></a></li>';
        }).join("");
}
