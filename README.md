# Spheretris

A 3D Tetris-like game played on the surface of a sphere. Drop hexagonal and pentagonal tiles to form complete layers and score points!

## Play the Game

You can play the latest version of Spheretris here: [https://tureentle.github.io/Spheretris/](https://tureentle.github.io/Spheretris/)

*(Note: It might take a few minutes for the GitHub Pages site to update after new changes are pushed.)*

## How to Play

*   **Objective:** Complete layers of tiles on the sphere to score points and prevent the tiles from stacking too high.
*   **Controls:**
    *   **Arrow Keys (Up, Down, Left, Right):** Rotate the sphere to position the falling tile.
    *   **Spacebar:** Hard drop the current tile.
    *   **'P' Key (Debug):** Force the next tile to be a pentagon.
    *   **'H' Key (Debug):** Force the next tile to be a hexagon.
*   **Gameplay:**
    *   Tiles of matching shapes (hexagon-on-hexagon, pentagon-on-pentagon) can be placed on the sphere's faces or stacked on existing tiles.
    *   Placing mismatched shapes (e.g., a hexagon tile on a pentagon face) will result in a penalty and the tile will not be placed.
    *   Complete a full layer of tiles (32) around the sphere to clear it and score points.
    *   The game ends if tiles stack too high on the outermost layer.

## Technologies Used

*   HTML5
*   CSS3
*   JavaScript (ES6+)
*   Three.js (for 3D graphics)

## Future Enhancements (Ideas)

*   Add different Shapes (H - H - H, H - P - H, P - H - P, H - H - P).
*   More complex scoring for combos or clearing multiple layers.
*   Different difficulty levels affecting fall speed or piece generation.
*   Visual polish: better particle effects for layer clears, improved UI.
*   Sound effects and background music.
