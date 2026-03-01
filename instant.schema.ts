import { i } from "@instantdb/admin";

const _schema = i.schema({
  entities: {
    $users: i.entity({
      email: i.string().unique().indexed(),
    }),
    projects: i.entity({
      name: i.string().indexed(),
      token: i.string().unique().indexed(),
      webhookUrl: i.string().optional(),
    }),
  },
  links: {
    projectOwner: {
      forward: {
        on: "projects",
        has: "one",
        label: "owner",
      },
      reverse: {
        on: "$users",
        has: "many",
        label: "projects",
      },
    },
  },
  rooms: {},
});

type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
