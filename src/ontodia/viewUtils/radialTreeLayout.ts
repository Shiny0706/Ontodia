/**
 * Created by tuyenhuynh on 18/03/17.
 */

export interface RadialLayoutNode {
    id: string;
    x?: number;
    y?: number;
    width: number;
    height: number;
    angularWidth?: number;
    angle?: number;
    children: RadialLayoutNode[];
}

let maxDepth = 0;
let radiusInc = 0;
export function radialTreeLayout(params: {
    root: RadialLayoutNode,
    deltaRadius: number,
    rootX: number,
    rootY: number
}) {
    maxDepth = 0;
    // Calculate angular width of each node
    calculateAngularWidth(params.root, 0);

    // Calculate position of each node, start from root
    if(maxDepth > 0) {
        let theta1 = 0, theta2 = 2*Math.PI;
        radiusInc = params.deltaRadius;
        layoutNode(params.root, params.deltaRadius, params.rootX, params.rootY, theta1, theta2);
    }
}

/**
 * Calculate angular width of a node base on its depth, size(as size of nodes may be variant) and children count
 *
 * @param node - node to calculate angular with of which
 * @param depth - level of node
 * @return angular width of node
 */
function calculateAngularWidth(node: RadialLayoutNode, depth: number) {
    if(depth > maxDepth) {
        maxDepth = depth;
    }
    let angularWidth = 0;
    let diameter = 0;
    let width = node.width, height = node.height;
    if(depth > 0) {
        diameter = Math.sqrt(width * width + height * height)/depth;
    }

    if(node.children.length > 0) {
        let childNodes = node.children;
        let childDepth = depth + 1;
        for(let childNode of childNodes) {
            angularWidth +=  calculateAngularWidth(childNode, childDepth);
        }
        angularWidth = Math.max(diameter, angularWidth);
    }else {
        angularWidth = diameter;
    }
    node.angularWidth = angularWidth;

    return angularWidth;
}

/**
 * Layout nodes
 *
 * @param node the root of the current considered subtree
 * @param radius the distance from current node to center
 * @param theta1 the start (in radians) of this subtree's angular region
 * @param theta2 the end (in radians) of this subtree's angular region
 */
function layoutNode(node: RadialLayoutNode, radius: number, rootX: number, rootY: number,
                    theta1: number, theta2: number) {
    let deltaTheta: number = (theta2 - theta1);
    let deltaTheta2: number = deltaTheta/2;
    let nodeAngularWidth = node.angularWidth;
    let nodeFraction = 0;
    let childNodes = node.children;
    if(childNodes.length > 0) {
        for(let childNode of childNodes) {
            let childAngularWidth = childNode.angularWidth;
            let childFraction = childAngularWidth/nodeAngularWidth;

            if(childNode.children.length > 0) {
                layoutNode(childNode, radius + radiusInc, rootX, rootY,
                    theta1 + nodeFraction * deltaTheta,
                    theta1 + (nodeFraction + childFraction)* deltaTheta);
            }

            let theta = theta1 + nodeFraction*deltaTheta + childFraction*deltaTheta2;
            childNode.x = rootX + radius * Math.cos(theta);
            childNode.y = rootY + radius * Math.sin(theta);
            childNode.angle = theta;
            nodeFraction += childFraction;
        }
    }
}
