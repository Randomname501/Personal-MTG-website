// Makes the "How many opponents?" input add and remove opponent fieldsets.
// Progressive enhancement only: the server renders the right number of rows, so
// with this script absent the form still submits and validates normally.
(function () {
  'use strict';

  document.querySelectorAll('.opponent-fields').forEach(function (root) {
    var countInput = root.querySelector('.opponent-count');
    var list = root.querySelector('.opponent-list');
    var template = root.querySelector('.opponent-template');
    if (!countInput || !list || !template) return;

    var max = Number(root.dataset.max) || 5;

    function rows() {
      return list.querySelectorAll('.opponent-row');
    }

    function addRow(index) {
      var markup = template.innerHTML.replace(/__i__/g, String(index));
      var holder = document.createElement('div');
      holder.innerHTML = markup;
      list.appendChild(holder.firstElementChild);
    }

    function resize(target) {
      var current = rows().length;
      // Rows are only ever appended or trimmed from the end, so indices stay
      // sequential and never need renumbering.
      for (var i = current; i < target; i++) addRow(i);
      for (var j = current; j > target; j--) list.lastElementChild.remove();
    }

    countInput.addEventListener('change', function () {
      var wanted = parseInt(countInput.value, 10);
      if (Number.isNaN(wanted)) return; // mid-edit; wait for a real value
      wanted = Math.min(Math.max(wanted, 1), max);
      countInput.value = String(wanted);
      resize(wanted);
    });

    // Keep the count honest if the browser restored a different row count.
    countInput.value = String(rows().length || 1);
  });
})();
