import { Image, type ImageStyle, type StyleProp } from "react-native";
import { avatarFor } from "./letterAvatars";

interface Props {
  /** User display name or email; first char picks the illuminated letter. */
  identity?: string | null;
  /** Rendered width/height (the avatar is square + fully round). */
  size: number;
  style?: StyleProp<ImageStyle>;
}

/**
 * Round illuminated-manuscript avatar derived from a user's initial.
 * Replaces the old plain-text initial in the account button + account screen.
 */
export function LetterAvatar({ identity, size, style }: Props) {
  return (
    <Image
      source={avatarFor(identity)}
      style={[{ width: size, height: size, borderRadius: size / 2 }, style]}
      resizeMode="cover"
      accessibilityRole="image"
    />
  );
}
