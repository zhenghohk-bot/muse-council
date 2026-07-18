import Image from "next/image";

/**
 * 先行者头像。传 pioneerId 时渲染 public/portraits/{id}.png（经 Next Image 优化，
 * 浏览器只收到按显示尺寸生成的小图，源 PNG 再大也不影响加载）。
 * 主持人 / 用户没有肖像，回退到文字（"主" / "你"）。
 */
export function PioneerAvatar({
  pioneerId,
  fallback,
  name,
  className
}: {
  pioneerId?: string;
  fallback: string;
  name?: string;
  className?: string;
}) {
  if (!pioneerId) {
    return <span className={className}>{fallback}</span>;
  }
  return (
    <span className={`pioneer-portrait ${className ?? ""}`}>
      <Image
        src={`/portraits/${pioneerId}.png`}
        alt={name ?? fallback}
        fill
        sizes="128px"
        style={{ objectFit: "cover" }}
      />
    </span>
  );
}
