(function () {
  const search = document.getElementById("demo-search");
  const status = document.getElementById("filter-status");
  const empty = document.getElementById("filter-empty");
  const activeTagWrap = document.getElementById("active-tag");
  const activeTagName = document.getElementById("active-tag-name");
  const clearTag = document.getElementById("clear-tag");
  const cards = Array.from(document.querySelectorAll(".card"));
  let selectedCategory = "All";
  let selectedTag = "";

  function normalize(value) {
    return (value || "").toLowerCase();
  }

  function tagsOf(card) {
    return (card.getAttribute("data-tags") || "")
      .split(",")
      .map(function (tag) { return tag.trim(); })
      .filter(Boolean);
  }

  function haystack(card) {
    const title = card.querySelector("h2") ? card.querySelector("h2").textContent : "";
    const descEl = card.querySelector("h2 + p");
    const desc = descEl ? descEl.textContent : "";
    return normalize(title + " " + desc + " " + tagsOf(card).join(" "));
  }

  function applyFilter() {
    const query = normalize(search.value.trim());
    let shown = 0;
    cards.forEach(function (card) {
      const category = card.getAttribute("data-category") || "";
      const tags = tagsOf(card);
      const categoryOk = selectedCategory === "All" || category === selectedCategory;
      const tagOk = !selectedTag || tags.indexOf(selectedTag) !== -1;
      const searchOk = !query || haystack(card).indexOf(query) !== -1;
      const match = categoryOk && tagOk && searchOk;
      card.hidden = !match;
      if (match) shown += 1;
    });
    status.textContent = "Showing " + shown + " of " + cards.length;
    empty.hidden = shown !== 0;
    document.querySelectorAll(".chip[data-category]").forEach(function (btn) {
      const on = btn.getAttribute("data-category") === selectedCategory;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    document.querySelectorAll(".tag").forEach(function (btn) {
      const on = selectedTag !== "" && btn.getAttribute("data-tag") === selectedTag;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    if (selectedTag) {
      activeTagName.textContent = selectedTag;
      activeTagWrap.hidden = false;
    } else {
      activeTagWrap.hidden = true;
    }
  }

  function setTag(tag) {
    selectedTag = selectedTag === tag ? "" : tag;
    applyFilter();
  }

  function paintTags() {
    cards.forEach(function (card) {
      const tags = tagsOf(card);
      if (!tags.length) return;
      let row = card.querySelector(".tags");
      if (!row) {
        row = document.createElement("p");
        row.className = "tags";
        const actions = card.querySelector(".actions");
        card.insertBefore(row, actions);
      }
      row.textContent = "";
      tags.forEach(function (tag) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tag";
        btn.setAttribute("data-tag", tag);
        btn.setAttribute("aria-pressed", "false");
        btn.textContent = tag;
        btn.addEventListener("click", function () { setTag(tag); });
        row.appendChild(btn);
      });
    });
  }

  function applyJson(list) {
    const bySlug = {};
    list.forEach(function (item) { bySlug[item.slug] = item; });
    cards.forEach(function (card) {
      const href = card.querySelector("a.shot") && card.querySelector("a.shot").getAttribute("href");
      const slug = (href || "").replace(/^\.\//, "").replace(/\/$/, "");
      const meta = bySlug[slug];
      if (!meta) return;
      card.setAttribute("data-slug", meta.slug);
      card.setAttribute("data-category", meta.category);
      card.setAttribute("data-tags", (meta.tags || []).join(","));
    });
  }

  paintTags();
  search.addEventListener("input", applyFilter);
  document.querySelectorAll(".chip[data-category]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      selectedCategory = btn.getAttribute("data-category");
      applyFilter();
    });
  });
  clearTag.addEventListener("click", function () {
    selectedTag = "";
    applyFilter();
  });
  applyFilter();

  fetch("./demos.json")
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (list) {
      if (!list) return;
      applyJson(list);
      paintTags();
      applyFilter();
    })
    .catch(function () {});
})();
