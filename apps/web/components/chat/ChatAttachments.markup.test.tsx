import { test, expect, spyOn, afterEach } from "bun:test";
import { api } from "@codecast/convex/convex/_generated/api";
import { mountWeb } from "../../test-helpers/mountWeb";
import { ChatAttachments } from "./ChatAttachments";

const VIDEO_URL = "https://storage.test/abc-123";
const IMAGE_URL = "https://storage.test/def-456";

afterEach(() => fetchMock?.mockRestore());
let fetchMock: ReturnType<typeof spyOn<typeof globalThis, "fetch">> | undefined;

test("a video attachment renders a player, never an image tile", async () => {
  fetchMock = spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 404 }),
  );
  const { backend, container } = await mountWeb(
    <ChatAttachments
      messageId="m1"
      attachments={[
        {
          storage_id: "st_lane_c_video",
          name: "IMG_3071.MOV",
          mime: "video/mp4",
        },
        { storage_id: "st_lane_c_image", name: "shot.png", mime: "image/png" },
      ]}
    />,
    {
      setup: (backend) =>
        backend.set(api.images.getImageUrls, {
          st_lane_c_video: VIDEO_URL,
          st_lane_c_image: IMAGE_URL,
        }),
    },
  );
  const player = container.querySelector("video");
  expect(player?.className).toBe("ch-att ch-att-video");
  expect(player?.getAttribute("src")).toBe(VIDEO_URL);
  expect(player?.controls).toBe(true);
  expect(container.querySelectorAll("img")).toHaveLength(1);
  expect(container.querySelector('img[alt="IMG_3071.MOV"]')).toBeNull();
  expect(backend.queryRequests).toEqual([
    {
      name: "images:getImageUrls",
      args: { storageIds: ["st_lane_c_video", "st_lane_c_image"] },
    },
  ]);
});
