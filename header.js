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
})();