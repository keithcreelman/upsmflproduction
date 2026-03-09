(function () {
  "use strict";

  if (!window.UPSReports) return;

  window.UPSReports.register({
    id: "franchise-assets",
    title: "Franchise Assets",
    familyId: "franchise",
    familyTitle: "Franchise Reports",
    familyOrder: 5,
    kicker: "Team-Level Insight",
    description: "Draft capital, contract exposure, and asset ledgers by franchise.",
    status: "planned",
    render: function (ctx) {
      ctx.common.renderPlaceholder(ctx.root, {
        title: "Franchise views stay team-centric by design",
        body: "The reports shell supports team-level modules, but phase 1 keeps the first live report strictly player-focused as requested.",
        items: [
          "Franchise asset ledgers and contract exposure.",
          "Draft capital tracking.",
          "Historical franchise performance views."
        ]
      });
    }
  });
})();
