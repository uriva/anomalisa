const rules = {
  projects: {
    allow: {
      view: "auth.email in data.ref('owner.email')",
      create: "isOwner",
      update: "isOwner",
      delete: "isOwner",
    },
    bind: {
      isOwner: "auth.email in data.ref('owner.email')",
    },
  },
};

export default rules;
